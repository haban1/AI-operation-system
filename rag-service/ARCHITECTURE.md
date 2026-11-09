# RAG Service Architecture

## Design Position

The service is a deterministic RAG workflow with one bounded Deep Agents node. Document ingestion, indexing, evidence gates, release construction, active-version switching, and rollback are ordinary application code. The model cannot publish, mutate knowledge, read files, execute commands, or choose its own database scope.

```text
Document API
  -> parser by format
  -> deterministic policy selection
  -> structure-aware chunks
  -> local embedding
  -> immutable document version

Query API
  -> validate scope and snapshot
  -> constrained query rewrite
  -> vector + BM25 retrieval
  -> reciprocal-rank fusion
  -> local cross-encoder: global rerank Top 6
  -> single-hop: score floor then at most 4 / multi-hop: retain all at most 6
  -> evidence gate over exactly that frozen set
  -> at most one retry (up to 4 queries), scoped merge/rerank/re-audit
  -> bounded Deep Agent synthesis over the same audited set
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
| Vector index | Qdrant local mode | Persistent cosine vector search and release collections |
| Lexical retrieval | `rank-bm25`, jieba | Chinese BM25 candidates |
| Reranking | FastEmbed + `BAAI/bge-reranker-base` | Local cross-encoder relevance score |
| State and traces | SQLite WAL | Metadata, versions, traces, feedback, and evaluations |

The chunk design follows the current Docling Hybrid/Hierarchical Chunker principles: preserve document hierarchy and table context first, then enforce the embedding-model size limit. Full Docling was intentionally not included in V1 because OCR and layout reconstruction are out of scope; the parser adapter can be replaced by Docling later without changing chunk, citation, or release contracts.

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

Selection is deterministic and traceable. Operators can override it when uploading through the debug UI. Chunk IDs bind document ID, immutable document version, ordinal, and content hash.

## Retrieval And Scores

1. Embed the original and constrained rewritten queries locally.
2. Gather vector and BM25 candidate pools.
3. Fuse ranks with reciprocal-rank fusion.
4. Run `BAAI/bge-reranker-base` once over the merged pool.
5. Freeze the evidence set before sufficiency, missing-detail, conflict, negative-case, and prompt-attack gates.
6. If evidence is insufficient, retry once within the same scope, merging first-round candidates.
7. Generate from the audited set without a second selection or tool-driven retrieval.

The operations RRF candidate cap remains 16 (with up to 6 first-round seed hits retained on retry),
with Dense/BM25 caps of 20 each and a global rerank output capped at 6. Single-hop uses
`max(0.02, top1_normalized * 0.10)` and at most 4; multi-hop retains all 6 without a floor.
The existing raw/sigmoid score semantics and channel minima remain unchanged. Coverage is
the union over the selected set; source diversity and gray-zone classification inspect all
selected chunks. Gray-zone classification can tighten, never relax, a channel minimum.

Response score meanings:

- `rerankerScore`: raw cross-encoder model output.
- `rerankerScoreNormalized`: monotonic sigmoid diagnostic normalization.
- `vectorScore`: cosine similarity.
- `lexicalScore`: normalized BM25 score.
- `retrievalScore`: hybrid ordering score.
- `grounding.confidence`: diagnostic evidence score combining reranker output, score gap, and retrieval agreement.

No score is advertised as a correctness probability. A calibrated probability or interval needs a separate labelled calibration set and versioned calibration model.

## Deep Agent Boundary

The query agent receives one custom read-only `search_knowledge` tool scoped by request-local `ContextVar` values. It can only re-read the frozen Gate evidence; it cannot retrieve new chunks or initiate a third retrieval round. Deep Agents filesystem tools, command execution, planning, and subagents are excluded. Safety-profile registration is fail-closed, tool calls are capped, model calls have a timeout, and any citation not present in retrieved evidence causes `NO_ANSWER` rather than automatic citation repair.

## Version And Release Model

- Source files are artifacts on disk; SQLite stores references and checksums.
- A document edit creates a new immutable `documentVersion`.
- A test session freezes `baseReleaseId` and exact candidate document versions.
- A release request must exactly match the session snapshot and have at least one test answer.
- Disabled-answer source chunks are excluded from the next manifest.
- Publish uses one SQLite transaction to verify the active base, mark the release published, and switch the active pointer.
- A stale concurrent build fails with `RELEASE_BASE_CHANGED` and cannot overwrite a newer active release.
- Rollback activates a retained immutable release and records an audit event and Trace.

## Trace Model

SQLite is the local canonical trace backend. Each run stores root metadata plus spans for parsing, chunking, embedding, rewrite, retrieval, evidence gates, model generation, release, and rollback. Candidate telemetry stores a bounded, redacted excerpt and score progression, not unrestricted metadata or embeddings. Reviewer feedback is immutable and idempotent.

OpenTelemetry, LangSmith, or Langfuse can be added as exporters. They are not required for local startup and do not replace the canonical local trace.

## Evaluation Contract

The evaluation runner accepts a caller-provided, versioned dataset. A useful suite should mix directly answerable questions, paraphrases, partial-evidence questions, missing-detail questions, malicious or prompt-injection inputs, and unrelated inputs. The data file and run outputs stay outside this framework repository.

Every run freezes the dataset hash and release ID. Assertions cover result, allowed reason codes, source identity, verified citations, answer/reference overlap, required facts, and actual model execution. Each failed assertion has a code and a query Trace ID.

## Conversation and Presentation Boundary

The original question and resolved search query remain separate. Search reformulation may
not add enrollment, current schedules, prices or complete-catalog requirements to a broad
overview. Missing evidence returns `NO_ANSWER`; the operations layer distinguishes it
from missing user intent. Direct-message evidence gaps do not consume clarification rounds.
Comment handoff, human requests, risk routes, snapshots and published-only scope remain
operations-owned.

An immutable per-knowledge-base answer profile is read at request start and only enters
answer generation. Its default brand is 智慧驱动. Grounding/citations and honest AI identity
take priority over style. Trace stores profile hash/version, not the custom style text.
See [operations integration guide](../docs/运营RAG兼容接入-20261106.md).

## Query plan and colloquial inputs

The planner emits a request-local plan with the original question, deterministic
context resolution, validated LLM canonical question, auxiliary queries, and
rejection diagnostics. The existing rewrite call receives bounded document-version
titles from the already frozen release or test chunk IDs, constrained by KB.
Titles help align terminology; they are not answer evidence or permission to add
prices, dates, identities, URLs, commitments, or unrelated user requirements.

Both formal queries and debug retrieval use that one plan. Recall retains the
original/context question and uses at most four variants; global reranking uses
the accepted canonical first. If its top score is below the existing channel
threshold, the already budgeted second round uses deterministic context resolution
for recall and reranking; other retry reasons retain the same intent view. The
actual query for each round is traced. A failed/disabled/invalid rewrite also uses
deterministic context resolution. The original question still governs Gate,
detail checks, negative cases, and generation. A rewrite cannot launder an original
attack or a disabled case; model-produced search text also passes the existing
attack filter. No shared mutable query-plan state or additional LLM call is added.

Flow: frozen scope → bounded title vocabulary + original/history → rewrite and
surface validation → recall/global rerank → single-hop up to four / multi-hop up
to six → Gate on original intent → identical evidence context → cited answer.
This keeps thresholds and budgets intact while fixing the former mismatch where
LLM rewrites influenced recall but the original colloquial query still controlled
final relevance scoring. Conservative validation is not semantic equivalence
proof; fixed-set answer review and unseen future data remain necessary.
