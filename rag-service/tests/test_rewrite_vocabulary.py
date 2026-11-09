"""Search title hints stay bounded and inside the resolved knowledge scope."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager

import pytest

from app.db import Database
from app.retrieval import HybridRetriever, SearchScope


@pytest.fixture
def retriever(tmp_path):
    # Scope vocabulary needs only SQLite; no embedding/reranker/vector index is
    # constructed, so a title lookup cannot silently invoke those providers.
    instance = object.__new__(HybridRetriever)
    instance.db = Database(tmp_path / "vocabulary.db")
    return instance


def add_document(db, document_id, title, *, knowledge_base_id="kb-a"):
    version, _ = db.create_document_version(
        document_id=document_id, knowledge_base_id=knowledge_base_id, title=title,
        filename=f"{document_id}.txt", mime_type="text/plain", byte_size=100,
        content_hash=f"hash-{document_id}", source_path=f"/unused/{document_id}.txt", metadata={},
    )
    chunk = {
        "chunk_id": f"chunk-{document_id}", "document_id": document_id,
        "document_version": version["document_version"], "ordinal": 0,
        "title": title, "text": "PRIVATE_BODY_MUST_NOT_BE_LOADED", "content_hash": f"chunk-hash-{document_id}",
        "embedding_blob": b"PRIVATE_EMBEDDING_MUST_NOT_BE_LOADED", "embedding_dim": 8,
    }
    db.insert_chunks([chunk])
    return chunk


def publish(db, release_id, members, *, knowledge_base_id="kb-a", active=False):
    db.create_release(
        release_id=release_id, knowledge_base_id=knowledge_base_id, knowledge_version=release_id,
        base_release_id=None, manifest={}, members=members, published_by="pytest", publish_note="scope fixture",
        enabled_count=0, disabled_count=0,
    )
    db.update_release(release_id, status="PUBLISHED", activate=active)


def test_release_vocabulary_uses_exact_release_and_both_kb_boundaries(retriever):
    db = retriever.db
    first = add_document(db, "a-first", "公司介绍")
    second = add_document(db, "a-second", "企业培训")
    newer = add_document(db, "a-newer", "尚未在目标版本发布的新课")
    add_document(db, "a-draft", "未发布草稿")
    foreign = add_document(db, "b-private", "其他知识库的内部资料", knowledge_base_id="kb-b")
    # The schema permits a malformed foreign release member; the title query
    # still has to enforce the document-version KB boundary independently.
    publish(db, "release-frozen", [first, second, foreign])
    publish(db, "release-new-active", [newer], active=True)
    publish(db, "release-b", [foreign], knowledge_base_id="kb-b", active=True)

    assert set(retriever.scope_vocabulary(SearchScope("kb-a", release_id="release-frozen"))) == {
        "公司介绍", "企业培训",
    }
    assert retriever.scope_vocabulary(SearchScope("kb-b", release_id="release-frozen")) == []
    assert retriever.scope_vocabulary(SearchScope("kb-a", release_id="release-b")) == []


def test_test_scope_uses_only_passed_chunk_ids_in_same_kb(retriever):
    db = retriever.db
    chosen = add_document(db, "chosen", "测试候选公司介绍")
    add_document(db, "unselected", "同库但未选中的文档")
    foreign = add_document(db, "foreign", "其他库的候选文档", knowledge_base_id="kb-b")
    scope = SearchScope("kb-a", chunk_ids=[chosen["chunk_id"], foreign["chunk_id"], "missing-id"], mode="TEST")
    assert retriever.scope_vocabulary(scope) == ["测试候选公司介绍"]
    assert retriever.scope_vocabulary(SearchScope("kb-a", chunk_ids=["missing-id"], mode="TEST")) == []


@pytest.mark.parametrize("mode", ["release", "test_ids"])
def test_vocabulary_uses_frozen_document_title_when_chunks_are_unnamed(retriever, mode):
    chunk = add_document(retriever.db, "named-document", "智慧驱动业务与服务介绍")
    with retriever.db.transaction() as conn:
        conn.execute("UPDATE chunks SET title=? WHERE chunk_id=?", ("未命名内容", chunk["chunk_id"]))
    publish(retriever.db, "named-release", [chunk])
    scope = (SearchScope("kb-a", release_id="named-release") if mode == "release"
             else SearchScope("kb-a", chunk_ids=[chunk["chunk_id"]], mode="TEST"))
    assert retriever.scope_vocabulary(scope) == ["智慧驱动业务与服务介绍"]


@pytest.mark.parametrize("scope", [SearchScope("kb-a", chunk_ids=[], mode="TEST"), SearchScope("kb-a")])
def test_empty_or_unfrozen_scope_never_falls_back_to_active_release(retriever, scope):
    chunk = add_document(retriever.db, "active", "全库词表不得泄露")
    publish(retriever.db, "active-release", [chunk], active=True)
    assert retriever.scope_vocabulary(scope) == []


@pytest.mark.parametrize("requested,expected", [(3, 3), (32, 32), (100, 32), (0, 0)])
def test_vocabulary_deduplicates_and_caps_title_count(retriever, requested, expected):
    chunks = [add_document(retriever.db, f"doc-{index}", f"业务主题-{index:02d}") for index in range(40)]
    chunks.append(add_document(retriever.db, "duplicate", "业务主题-00"))
    chunks.append(add_document(retriever.db, "empty-title", "   "))
    scope = SearchScope("kb-a", chunk_ids=[chunk["chunk_id"] for chunk in chunks], mode="TEST")
    result = retriever.scope_vocabulary(scope, limit=requested)
    assert len(result) == expected
    assert len(result) == len(set(result))
    assert all(title.strip() for title in result)


def test_vocabulary_caps_each_title_and_total_characters_after_truncation(retriever):
    chunks = [
        add_document(retriever.db, f"long-{index}", f"{index:02d}-" + "长标题内容" * 40)
        for index in range(40)
    ]
    chunks.extend([
        add_document(retriever.db, "same-prefix-a", "共用前缀" * 40 + "甲"),
        add_document(retriever.db, "same-prefix-b", "共用前缀" * 40 + "乙"),
    ])
    scope = SearchScope("kb-a", chunk_ids=[chunk["chunk_id"] for chunk in chunks], mode="TEST")
    result = retriever.scope_vocabulary(scope)
    assert 1 < len(result) <= 32
    assert all(0 < len(title) <= 120 for title in result)
    assert sum(map(len, result)) <= 2500
    assert len(result) == len(set(result))


@pytest.mark.parametrize("mode", ["release", "test_ids"])
def test_scope_vocabulary_reads_titles_without_loading_text_or_embeddings(retriever, monkeypatch, mode):
    chunk = add_document(retriever.db, "title-only", "可用标题")
    publish(retriever.db, "title-release", [chunk])
    scope = (SearchScope("kb-a", release_id="title-release") if mode == "release"
             else SearchScope("kb-a", chunk_ids=[chunk["chunk_id"]], mode="TEST"))
    original_connection = retriever.db.connection
    columns_read = []

    def authorize(action, table, column, database, trigger):
        if action == sqlite3.SQLITE_READ:
            columns_read.append((table, column))
            if table == "chunks" and column in {"text", "lexical_text", "embedding_blob", "embedding_dim"}:
                return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    @contextmanager
    def title_only_connection():
        with original_connection() as conn:
            conn.set_authorizer(authorize)
            yield conn

    monkeypatch.setattr(retriever.db, "connection", title_only_connection)
    assert retriever.scope_vocabulary(scope) == ["可用标题"]
    assert ("document_versions", "title") in columns_read
