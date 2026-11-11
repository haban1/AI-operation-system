# RAG Service Architecture

## Design Position

The service is a deterministic RAG workflow with one bounded Deep Agents node. File ingestion, indexing, evidence gates, and atomic internal snapshot switching are ordinary application code. The model cannot publish, mutate knowledge, read files, execute commands, or choose its own database scope.

```text
File CRUD API
  -> parser by format
  -> deterministic policy selection
  -> structure-aware chunks
  -> local embedding
  -> immutable document version
  -> build internal retrieval snapshot
  -> atomically activate (preserve previous contents on failure)

Query API
  -> validate scope and snapshot
  -> constrained query rewrite
  -> vector + BM25 retrieval
  -> reciprocal-rank fusion
  -> local cross-encoder rerank
  -> deterministic evidence gate
  -> bounded Deep Agent synthesis
  -> citation validation
  -> ANSWERED or NO_ANSWER
```

## Open-Source Components

| Area | Component | Use |
|---|---|---|
| API and schema | FastAPI, Pydantic | HTTP contract, validation, OpenAPI |
| Agent runtime | `deepagents==0.7.9`, LangGraph | Read-only query synthesis node |
| PDF | PyMuPDF | Text-bearing PDF parsing and page locations |
| DOCX | python-docx | Paragraph headings and table rows |
| XLSX | openpyxl | Sheet, header, and row preservation |
| Long-text chunking | LangChain `RecursiveCharacterTextSplitter` | Chinese-aware recursive separators |
| Embedding | FastEmbed + `BAAI/bge-small-zh-v1.5` | Local 512-dimensional Chinese vectors |
| Vector index | Qdrant local mode | Persistent cosine vector search and snapshot collections |
| Lexical retrieval | `rank-bm25`, jieba | Chinese BM25 candidates |
| Reranking | FastEmbed + `BAAI/bge-reranker-base` | Local cross-encoder relevance score |
| State and traces | SQLite WAL | File metadata, versions, traces, and feedback |

The chunk design follows the current Docling Hybrid/Hierarchical Chunker principles: preserve document hierarchy and table context first, then enforce the embedding-model size limit. Full Docling was intentionally not included in V1 because OCR and layout reconstruction are out of scope; the parser adapter can be replaced by Docling later without changing chunk, citation, or internal snapshot contracts.

Primary upstream references:

- Deep Agents: <https://github.com/langchain-ai/deepagents>
- Docling chunking: <https://github.com/docling-project/docling/blob/main/docs/concepts/chunking.md>
- FastEmbed: <https://github.com/qdrant/fastembed>
- Qdrant: <https://github.com/qdrant/qdrant>
- Sentence Transformers retrieve/rerank design: <https://www.sbert.net/examples/applications/retrieve_rerank/README.html>

## Chunk Policies

| Policy | Selection | Behavior |
|---|---|---|
| `FAQ_STRUCTURED` | FAQ column names or structured rows | One FAQ per chunk; question, answer, keywords, category, row location retained |
| `TABLE_ROWS` | Table-heavy DOCX/XLSX | Keep each row intact and repeat headers in metadata |
| `MARKDOWN_HIERARCHICAL` | Markdown or heading-bearing document | Carry heading path into each chunk; recursively split oversized sections |
| `PROSE_RECURSIVE` | Plain prose or text-bearing PDF | Merge nearby paragraphs, then split on paragraph/sentence/Chinese punctuation boundaries |

Selection is deterministic and traceable; the file UI does not expose policy configuration. Chunk IDs bind document ID, immutable document version, ordinal, and content hash.

## Retrieval And Scores

1. Embed the original and constrained rewritten queries locally.
2. Gather vector and BM25 candidate pools.
3. Fuse ranks with reciprocal-rank fusion.
4. Run `BAAI/bge-reranker-base` once over the merged pool.
5. Apply evidence sufficiency, missing-detail, conflict and prompt-attack gates. Retired Xiaozhi negative-case decisions no longer affect formal answers.

Response score meanings:

- `rerankerScore`: raw cross-encoder model output.
- `rerankerScoreNormalized`: monotonic sigmoid diagnostic normalization.
- `vectorScore`: cosine similarity.
- `lexicalScore`: normalized BM25 score.
- `retrievalScore`: hybrid ordering score.
- `grounding.confidence`: diagnostic evidence score combining reranker output, score gap, and retrieval agreement.

No score is advertised as a correctness probability. A calibrated probability or interval needs a separate labelled calibration set and versioned calibration model.

## Deep Agent Boundary

The query agent receives one custom read-only `search_knowledge` tool scoped by a request-local `ContextVar`. Deep Agents filesystem tools, command execution, planning, and subagents are excluded. Safety-profile registration is fail-closed, tool calls are capped, model calls have a timeout, and any citation not present in retrieved evidence causes `NO_ANSWER` rather than automatic citation repair.

## File Lifecycle And Internal Snapshots

- `file_api.py` owns authenticated file routes and idempotent upload/replace. `file_manager.py` owns activation, deletion, state mapping, and recovery.
- Source files are artifacts on disk; SQLite stores references and checksums. Independent uploads retain separate IDs even when bytes match.
- Replacement retains the document ID and creates an immutable `documentVersion`. Parsing and embedding run asynchronously; successful indexing replaces only that file in the active snapshot. Failures preserve previous effective contents.
- Each activation starts from current snapshot members, replaces the target, builds an index, and atomically switches the pointer. Changes are serialized per knowledge base; the database also compares the expected base pointer so stale builds cannot overwrite newer contents.
- Delete builds a snapshot without the target and commits its tombstone in the same pointer-switch transaction. Tombstoned files are hidden from list/detail/chunk APIs and formal retrieval. Deleting the final file leaves an empty snapshot.
- Restart recovery resumes parsing and managed files parsed but not yet activated.
- Historical source versions, indexes, and existing review tables remain internal. They support consistent in-flight reads and maintenance backups, not physical erasure or operator rollback.

Database names such as `releases`, `active_release_id`, and parser state `READY_FOR_TEST` remain compatibility details. The file API reports `ACTIVE`, `PROCESSING`, `FAILED`, or `INACTIVE`; test-session, release, rollback, decision, and evaluation management APIs remain removed. Formal query/retrieve, persona configuration, embeddings, authentication, and trace feedback remain.

The platform Web proxy fixes the business scope and uploader. Auto-content and material-draft ingestion use the file contract without test sessions or publish tasks. UI and API details are in [file management](../docs/knowledge-files.md).

## Persona And Local RAG Playground

`persona_api.py` reuses administrator/service authentication and validates four presentation fields. `persona.py` persists settings per knowledge base in `service_meta`; corrupt saved values fall back to defaults. `run_query` freezes the profile before retrieval. Both direct and bounded-agent generation use that snapshot. Editing style does not reindex files or switch the active pointer, and cannot weaken evidence, citation, identity, or action rules.

Web `POST /api/rag/test-query` constructs an ordinary `/rag-api/v1/query` request with fixed business scope, mandatory grounding, fresh IDs, and a `LOCAL_TEST` conversation namespace separated by operator/session. It validates paired context (three rounds/six entries, 12000 characters), question size (4000), source platform/channel, and returned snapshot. It directly returns RAG results and citations; it never calls the platform message router, job queue, notifications, or retired review services. The browser holds up to 30 visible exchanges in memory, clears on logout, and sends only the last three rounds for follow-ups; comments send no history. Aborted/obsolete responses cannot revive cleared conversations. This tests RAG behavior rather than the complete outer channel/send policy.

## Trace Model

SQLite is the local canonical trace backend. Each run stores root metadata plus spans for parsing, chunking, embedding, rewrite, retrieval, evidence gates, model generation, and internal index construction. Candidate telemetry stores a bounded, redacted excerpt and score progression, not unrestricted metadata or embeddings. Reviewer feedback is immutable and idempotent.

OpenTelemetry, LangSmith, or Langfuse can be added as exporters. They are not required for local startup and do not replace the canonical local trace.

## Verification Boundary

`tests/test_file_manager.py` verifies the lifecycle plus saved persona propagation and immutability during a real query pipeline. `tests/test_answer_profile.py` checks persistence, validation, isolation, and authentication; `tests/test_reply_style.py` checks direct and agent generation boundaries. `tests/test_local_embeddings.py` covers embeddings. Node tests cover authenticated local queries without business writes, persona transport, desktop/mobile tools and CRUD, and retained business routing.

Historical evaluation/review scripts and fixtures target retired workflows and are not active management APIs or current acceptance commands. Business datasets and runtime output stay outside Git. The [change record](../docs/changes/2026-11-10-knowledge-files.md) records exact commands, observed results, deployment status, and limitations; these tests do not prove real platform sending or publishing.
