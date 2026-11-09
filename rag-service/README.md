# Local RAG Service

Standalone local-first RAG service for the AI digital-operations system. It exposes the business contract under `/rag-api/v1/*`, administrative and debug capabilities under `/rag-admin-api/v1/*`, and a developer control room at `/`.

## What It Does

- Accepts PDF, DOCX, XLSX, TXT, Markdown, CSV, TSV, JSON, and JSONL sources.
- Uses format-aware deterministic chunk policies. FAQ rows stay intact; long content uses the open-source LangChain recursive splitter with structure metadata retained.
- Uses FastEmbed `BAAI/bge-small-zh-v1.5` for local Chinese embeddings and `BAAI/bge-reranker-base` for local cross-encoder reranking.
- Uses Qdrant local mode for persistent vector indexing, with a SQLite/NumPy fallback for development.
- Uses hybrid vector + BM25 retrieval, reciprocal-rank fusion, reranking, evidence gating, source citations, and fail-closed `NO_ANSWER` behavior.
- Uses a bounded Deep Agents 0.7.x query synthesizer. The agent receives only a read-only `search_knowledge` tool; filesystem tools, shell execution, and subagents are not exposed.
- Stores immutable document versions, test sessions, test decisions, releases, active-release pointer, rollback history, traces, candidate scores, feedback, and evaluation runs in SQLite.

## Local Start

Python 3.11-3.13 is supported. The repository includes a locked `uv` environment:

```bash
uv sync
cp .env.example .env
uv run uvicorn app.main:app --host 127.0.0.1 --port 18080
```

For local development, the launcher can optionally read an operator-provided token document into process memory without writing the URL or key to `.env`:

```bash
uv run python scripts/start_local.py --port 18280
```

The port is configurable. Use a different port when another local service already owns the default.

Open <http://127.0.0.1:18080/> and use the local token from `RAG_BEARER_TOKEN` (the development default is `dev-local-token`). Do not put a real provider key in Git or in frontend code.

The first ingestion downloads the embedding model. The first query that reaches reranking downloads the cross-encoder model. Keep `RAG_MODEL_CACHE_DIR` on a persistent volume.

## Provider Configuration

Set these variables in `.env` or the process environment:

```dotenv
RAG_LLM_BASE_URL=https://your-openai-compatible-host/v1
RAG_LLM_API_KEY=provided-out-of-band
RAG_LLM_MODEL=gpt-5.6-sol
RAG_GENERATION_PROVIDER=openai_compatible
RAG_DEEP_AGENT_ENABLED=true
```

Embedding and reranking remain local by default. If no generation endpoint is configured, the service uses a clearly labelled deterministic top-evidence fallback for development. Provider state is visible in the UI and health response.

When launched by the operations platform's `start-mvp.ps1`, its `src/start-rag.js` shares the operator's saved AI configuration through child-process environment variables, without writing provider credentials to this repository. Complete, explicitly configured RAG credentials take priority. Restart the local services after changing the platform's AI settings. The installed operations profile disables optional query rewriting and Deep Agents and uses direct, grounded generation after semantic retrieval and reranking; disabling these optional steps is not a provider failure. It also requires valid local models instead of silently using development fallback vectors.

## Import A Knowledge Source

Upload a supported source from Documents, wait for `READY_FOR_TEST`, create a `PRE_RELEASE` or `SINGLE_DOCUMENT` test session, review answers, and publish from Releases. The same flow is available through the documented admin APIs. Source files and generated indexes are runtime data and should stay outside Git.

## API Groups

| Group | Routes |
|---|---|
| Formal | `GET /rag-api/v1/health`, `POST /rag-api/v1/query` |
| Ingestion | `POST/GET/DELETE /rag-admin-api/v1/documents`, `GET .../chunks` |
| Review | `POST /rag-admin-api/v1/test-sessions`, `POST .../query`, `PUT .../decision` |
| Release | `POST /rag-admin-api/v1/knowledge-bases/{id}/releases`, `GET /rag-admin-api/v1/releases`, `POST .../rollback` |
| Debug | `POST /rag-admin-api/v1/debug/query`, provider and chunk inspection routes |
| Observability | `GET /rag-admin-api/v1/traces`, `GET .../{traceId}`, `POST .../feedback` |
| Evaluation | `POST /rag-admin-api/v1/evaluations/run`, `GET .../{evalRunId}` |

Swagger is available at `/docs`; the frontend API Surface tab lists the same routes.

See [ARCHITECTURE.md](ARCHITECTURE.md) for component boundaries, upstream open-source references, chunk policy selection, score semantics, release concurrency controls, and the evaluation contract.

## Trace And Score Semantics

Each query trace records preparation, rewrite, hybrid retrieval, evidence gate, answer generation, citations, errors, and candidate score progression. The response exposes:

- `rerankerScore`: raw model output;
- `rerankerScoreNormalized`: monotonic diagnostic normalization used for ranking;
- `retrievalScore`: final hybrid ranking score;
- `grounding.confidence`: a diagnostic evidence score combining top reranker score, score gap, and retrieval agreement;
- `grounding.confidenceType=DIAGNOSTIC_NOT_CALIBRATED_PROBABILITY`.

These values are not correctness probabilities. A calibrated probability or interval requires a labelled evaluation set and a separately versioned calibration model.

Reviewers can mark a trace `GOOD` or `BAD` and attach a note. Test answers can be `ENABLED` or `DISABLED`; disabled cases create scoped negative regression records and can block a release when their rejected source remains in the candidate snapshot.

## Docker

Docker is not installed on the current development machine, but the image and Compose configuration are included:

```bash
cp .env.example .env
docker compose up --build
```

The model cache and `data/` directory are mounted so releases and downloaded models survive restarts. The container binds to loopback by default through Compose.

## Evaluation

Generate or refresh the bundled matrix:

```bash
uv run python scripts/generate_eval.py
```

Use the evaluation scripts with a project-owned, versioned dataset that is kept outside the framework repository. Every case should store a Trace ID; strict assertions should cover result, allowed reason code, verified citations, source identity, answer/reference overlap, required terms, and actual model execution without fallback. The repository intentionally does not include business evaluation data or run outputs.

Pass the dataset explicitly when running the CLI:

```bash
uv run python scripts/run_eval.py --dataset /path/to/evaluation.json --base-url http://127.0.0.1:18080 --token "$RAG_BEARER_TOKEN"
```

## Conversation Context

V1 callers send the current message in `query.text` and preceding `USER` / `ASSISTANT` turns in `context` (the generic contract accepts up to 12 entries and 12000 characters). The operations platform applies a stricter product limit of three historical rounds, at most six entries, of collected user messages and confirmed AI replies, excluding unsent drafts. Its Xiaozhi test entry also uses three rounds. The current question does not occupy a historical round. The answer model receives the full bounded history. The service does not read browser chat history or store shared conversation memory.

Short follow-ups are combined with the latest conversation topic before both retrieval and reranking, including when optional LLM query rewriting is disabled. Explicit topic switches reset the topic. History helps resolve references; answers still require evidence from the current published release. Material that only exists in unpublished knowledge cannot justify a formal answer.

## Security Boundaries

- Formal queries can only use the active published release. They cannot select drafts or candidate documents.
- User/context/document text is treated as untrusted data and cannot execute tools, commands, or instructions.
- The service never receives platform cookies, platform credentials, or enterprise messaging secrets.
- Trace payloads are redacted and bounded by default. Full raw prompts are not stored by default.
- Publication and rollback are explicit operator actions; a failed build never moves the active pointer.

## Colloquial query normalization

With `RAG_QUERY_REWRITE_ENABLED=true`, the existing rewrite call now produces a
`canonical_question` and a bounded `queries` list. The canonical question removes
spoken filler, corrects clear technical typos, and resolves references from the
supplied conversation without answering or adding facts. The rewrite prompt also
receives at most 32 document-version titles from the frozen release/test IDs and
knowledge base (120 characters each, 2500 total), so terms match the actual scope.
This SQL lookup reads metadata only, not source bodies or vectors. Titles are
search vocabulary, never answer evidence or identity proof; multiple institutions
must not be arbitrarily resolved, and an explicit current/context subject wins. The validated canonical
is used for first-round recall and global reranking. If its top relevance score
is below the existing channel threshold, the existing second round tries the
deterministic context-resolved question, retaining first-round seeds and the
four-query retry cap. Each round records its actual rerank question. The original
question, first canonical and deterministic resolution remain in the plan/Trace.
Formal queries and debug retrieval share that same planner.

The prompt requires preservation of explicit entities, numbers, time limits,
negations, and comparisons. Deterministic validation rejects malformed output and
certain lost or invented anchors; it is a conservative guard, not a proof of
semantic equivalence. Title hints cannot authorize new numbers, amounts, dates,
URLs or promises. Both canonical and auxiliary queries also pass the existing
prompt-attack boundary. On rejection, provider failure, or disabled rewriting, the
existing deterministic question is used. Safe original/context variants remain in
the maximum four retrieval queries. No additional model call or rerank pass is
introduced, although the rewrite prompt/output budget is larger.

The original question still governs Evidence Gate, exact-detail checks, negative
cases, and grounded generation. A normalized query is only a relevance hint. The
channel threshold, two-round/four-retry-query budgets, published knowledge scope,
single-hop four/multi-hop six evidence limits, and audited-context identity stay
unchanged. A higher rerank score does not establish factual correctness; evaluate
supported answers and unsupported requests separately on a fixed corpus.
