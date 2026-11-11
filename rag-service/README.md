# Local RAG Service

Standalone local-first RAG service for the AI digital-operations system. It exposes the business contract under `/rag-api/v1/*`, file management and maintenance endpoints under `/rag-admin-api/v1/*`. The platform knowledge page provides the UI; `/` returns service metadata.

## What It Does

- Accepts PDF, DOCX, XLSX, TXT, Markdown, CSV, TSV, JSON, and JSONL sources.
- Uses format-aware deterministic chunk policies. FAQ rows stay intact; long content uses the open-source LangChain recursive splitter with structure metadata retained.
- Uses FastEmbed `BAAI/bge-small-zh-v1.5` for local Chinese embeddings and `BAAI/bge-reranker-base` for local cross-encoder reranking.
- Uses Qdrant local mode for persistent vector indexing, with a SQLite/NumPy fallback for development.
- Uses hybrid vector + BM25 retrieval, reciprocal-rank fusion, reranking, evidence gating, source citations, and fail-closed `NO_ANSWER` behavior.
- Uses a bounded Deep Agents 0.7.x query synthesizer. The agent receives only a read-only `search_knowledge` tool; filesystem tools, shell execution, and subagents are not exposed.
- Automatically activates uploaded or replaced files through immutable internal snapshots and an atomic active pointer. SQLite also stores file metadata, traces, candidate scores, and feedback. Historical review tables remain as inert compatibility data.

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

Manage files from the platform knowledge page. Direct API clients use the configured `RAG_BEARER_TOKEN`; OpenAPI is available at `/docs`. Do not put real tokens or provider keys in Git or frontend code.

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

Embedding and reranking remain local by default. If no generation endpoint is configured, the service uses a clearly labelled deterministic top-evidence fallback for development. Provider state is visible in health and authenticated provider responses.

When launched by the operations platform's `start-mvp.ps1`, its `src/start-rag.js` shares the operator's saved AI configuration through child-process environment variables, without writing provider credentials to this repository. Complete, explicitly configured RAG credentials take priority. Restart the local services after changing the platform's AI settings. The installed operations profile disables optional query rewriting and Deep Agents and uses direct, grounded generation after semantic retrieval and reranking; disabling these optional steps is not a provider failure. It also requires valid local models instead of silently using development fallback vectors.

## Manage Knowledge Files

Upload a supported file (up to 50 MB) from the platform knowledge page. Parsing and indexing run asynchronously and successful files become available automatically. Search by filename, inspect parsed content, replace a file retaining its document ID, or delete it. Replacement failure preserves previous effective contents; deletion removes the file from the current list and formal retrieval.

The platform also offers answer persona settings and a local RAG playground. Saved presentation settings apply to the next formal or test query; they do not change evidence gates. The playground calls the normal grounded query API against current files without writing business messages or send jobs. The old Xiaozhi review/decision workflow, manual release/rollback, aliases, and custom handoff-phrase management remain removed. Source files and indexes are private runtime data outside Git; deletion retains historical versions internally. See [file management](../docs/knowledge-files.md).

## API Groups

| Group | Routes |
|---|---|
| Formal | `GET /rag-api/v1/health`, `POST /rag-api/v1/query`, separately authenticated `POST /rag-api/v1/retrieve` |
| Files | `GET/POST /rag-admin-api/v1/files`, `GET/PUT/DELETE .../files/{id}`, `GET .../files/{id}/chunks` |
| Answer persona | `GET/PUT /rag-admin-api/v1/knowledge-bases/{id}/answer-profile` |
| Embeddings | `POST /rag-admin-api/v1/embeddings` |
| Maintenance | `GET /rag-admin-api/v1/system/providers`, `.../chunk-policies`, `.../status` |
| Observability | `GET /rag-admin-api/v1/traces`, `GET .../{traceId}`, `POST .../feedback` |

Upload and replacement use multipart `file` and JSON-encoded `metadata` selecting the knowledge base and uploader. Platform Web requests fix the business scope on the server. Persona settings persist per knowledge base in `service_meta`, with immutable per-query snapshots. Old documents/test-session/release/rollback/debug-query/evaluation management routes return 404. Platform Web exposes `POST /api/rag/test-query` for bounded local conversations and proxies persona at `/api/rag/answer-profile`; both require the normal administrator session.

See [ARCHITECTURE.md](ARCHITECTURE.md) for component boundaries, chunk policies, scores, and atomic file updates.

## Trace And Score Semantics

Each query trace records preparation, rewrite, hybrid retrieval, evidence gate, answer generation, citations, errors, and candidate score progression. The response exposes:

- `rerankerScore`: raw model output;
- `rerankerScoreNormalized`: monotonic diagnostic normalization used for ranking;
- `retrievalScore`: final hybrid ranking score;
- `grounding.confidence`: a diagnostic evidence score combining top reranker score, score gap, and retrieval agreement;
- `grounding.confidenceType=DIAGNOSTIC_NOT_CALIBRATED_PROBABILITY`.

These values are not correctness probabilities. A calibrated probability or interval requires a labelled evaluation set and a separately versioned calibration model.

Maintenance clients can mark a trace `GOOD` or `BAD` and attach a note. Feedback does not gate file activation or formal answers.

## Docker

The image and Compose configuration are included:

```bash
cp .env.example .env
docker compose up --build
```

Persist the model cache and `data/` directory so file contents, effective indexes, and models survive restarts. Compose binds to loopback by default. For the full operations workspace use the repository workbench launcher rather than mixing standalone data directories.

## Verification

From `rag-service/`:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_answer_profile.py tests/test_reply_style.py tests/test_file_manager.py tests/test_local_embeddings.py -q
```

Isolated tests cover files, formal retrieval, persona persistence/validation/immutability, generation prompt boundaries, concurrency, recovery, and retired routes. Historical review/evaluation tests and scripts target removed workflows and are not current acceptance commands. Business datasets and outputs stay outside Git. Deployment evidence and limitations are in the [file record](../docs/changes/2026-11-10-knowledge-files.md) and [playground record](../docs/changes/2026-11-10-knowledge-playground.md).

## Conversation Context

V1 callers send the current message in `query.text` and preceding `USER` / `ASSISTANT` turns in `context` (the generic contract accepts up to 12 entries and 12000 characters). The operations platform applies a stricter product limit of three historical rounds, at most six entries, of collected user messages and confirmed AI replies, excluding unsent drafts. The current question does not occupy a historical round. The answer model receives the full bounded history. The service does not read browser chat history or store shared conversation memory.

Short follow-ups are combined with the latest conversation topic before both retrieval and reranking, including when optional LLM query rewriting is disabled. Explicit topic switches reset the topic. History helps resolve references; answers still require evidence from the current effective file snapshot. Files whose parsing or indexing has not completed cannot justify a formal answer.

## Security Boundaries

- Formal queries use the active internal snapshot, not arbitrary historical versions or files still being processed.
- User/context/document text is treated as untrusted data and cannot execute tools, commands, or instructions.
- The service never receives platform cookies, platform credentials, or enterprise messaging secrets.
- Trace payloads are redacted and bounded by default. Full raw prompts are not stored by default.
- File operations change the active snapshot only after successful indexing; a failed build never moves the pointer. There is no operator release or rollback API.
