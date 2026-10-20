from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Iterable

import jieba
from rank_bm25 import BM25Plus


jieba.setLogLevel(logging.ERROR)

_STOPWORDS = {
    "的",
    "了",
    "吗",
    "呢",
    "吧",
    "啊",
    "呀",
    "和",
    "与",
    "或",
    "在",
    "是",
    "有",
    "能",
    "可以",
    "是否",
    "什么",
    "怎么",
    "如何",
    "哪里",
    "在哪",
    "请问",
    "想问",
    "咨询",
    "一下",
    "这个",
    "那个",
    "关于",
}
_STOPWORD_CHARACTERS = {
    token
    for token in _STOPWORDS
    if len(token) == 1
}


@dataclass(frozen=True)
class BM25Hit:
    index: int
    score: float


def rank_bm25(
    query: str,
    documents: list[str],
    *,
    custom_terms: Iterable[str] = (),
) -> list[BM25Hit]:
    if not query.strip() or not documents:
        return []

    terms = [term.strip() for term in custom_terms if term.strip()]
    for term in terms:
        jieba.add_word(term)

    corpus = [tokenize_bm25(document) for document in documents]
    if not any(corpus):
        return []
    query_tokens = tokenize_bm25(query)
    if not query_tokens:
        return []

    query_token_set = set(query_tokens)
    scores = BM25Plus(corpus).get_scores(query_tokens)
    hits = [
        BM25Hit(index=index, score=float(score))
        for index, score in enumerate(scores)
        if float(score) > 0
        and query_token_set.intersection(corpus[index])
    ]
    hits.sort(key=lambda hit: hit.score, reverse=True)
    return hits


def tokenize_bm25(value: str) -> list[str]:
    normalized = _normalized_text(value)
    if not normalized:
        return []

    words = [
        token.strip()
        for token in jieba.cut_for_search(normalized)
        if _is_useful_word(token.strip())
    ]
    compact = re.sub(r"\s+", "", normalized)
    character_bigrams = [
        compact[index : index + 2]
        for index in range(max(0, len(compact) - 1))
        if _is_useful_bigram(compact[index : index + 2])
    ]
    return [*words, *character_bigrams]


def _normalized_text(value: str) -> str:
    return re.sub(
        r"[^\w\u4e00-\u9fff]+",
        " ",
        value.lower(),
        flags=re.UNICODE,
    ).strip()


def _is_useful_word(token: str) -> bool:
    if not token or token in _STOPWORDS:
        return False
    return len(token) > 1 or not _is_chinese_character(token)


def _is_chinese_character(token: str) -> bool:
    return len(token) == 1 and "\u4e00" <= token <= "\u9fff"


def _is_useful_bigram(token: str) -> bool:
    return (
        token not in _STOPWORDS
        and not any(character in _STOPWORD_CHARACTERS for character in token)
    )
