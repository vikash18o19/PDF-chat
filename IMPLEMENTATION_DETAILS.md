# AI-PDF · Integration Guide

This document explains how the project uploads PDFs into Snowflake, chunk/vectorizes their text with Cortex, and retrieves relevant passages plus AI responses. Reuse these workflows inside other apps by importing the referenced modules (`lib/workflows`, `lib/pdf`, `lib/snowflake`).

## 1. Configuration Surface

All services consume the same `.env` file (see `.env` and `lib/env.ts`). Required keys:

| Key | Purpose |
| --- | --- |
| `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PASSWORD`, `SNOWFLAKE_ROLE`, `SNOWFLAKE_WAREHOUSE` | Direct Snowflake credentials used by both the GUI (`snowflake_gui.py`) and the Next.js APIs. |
| `SNOWFLAKE_DATABASE`, `SNOWFLKE_SCHEMA` | Namespace where tables + stages are created. |
| `SNOWFLAKE_STAGE` | Stage target for raw PDFs (`@<db>.<schema>.<stage>`). |
| `CORTEX_EMBED_MODEL`, `CORTEX_LLM_MODEL` | Cortex function identifiers for embeddings + completions. |
| `VECTOR_DIM`, `CHUNK_SIZE`, `CHUNK_OVERLAP` | Chunking + vector settings (`lib/pdf.ts`). |

`lib/env.ts` validates these values with `zod` and exports:
- `env`: strongly typed config object
- `TABLE_DOCUMENTS`, `TABLE_VECTORS`: fully qualified table names
- `STAGE_REFERENCE`: `@stage` shorthand used by upload workflows

## 2. Schema & Infrastructure Bootstrap

`lib/snowflake.ts` wraps the Snowflake SDK:

1. `withSnowflakeConnection(handler)` opens/closes a connection per operation.
2. `ensureInfrastructure(connection)` runs on every workflow. It creates:
   - Stage defined by `SNOWFLAKE_STAGE`
   - `PDF_DOCUMENTS` table for per-file metadata (`file_id`, `stage_path`, chunk count, JSON metadata)
   - `PDF_VECTORS` table for chunks, embeddings, provenance JSON, timestamps
3. `ensureVectorColumnShape` automatically recreates `PDF_VECTORS.EMBEDDING` if `VECTOR_DIM` changes.

The same helper is reused by API routes, CLI, and GUI scripts, so you can call any workflow without worrying about setup.

## 3. Upload ➝ Stage ➝ Vectorize Pipeline

Primary entrypoint: `ingestPdf(buffer, filename)` in `lib/workflows.ts`.

1. Generate `fileId = uuid4()` and normalize the filename.
2. Write the PDF contents to a temp file so Snowflake can read from `file://`.
3. Chunk text locally via `chunkPdf` (`lib/pdf.ts`). It uses `pdf-parse` to extract text, splits by form-feed/paragraphs, and slices with length `CHUNK_SIZE`, overlapping `CHUNK_OVERLAP` characters.
4. Inside a Snowflake connection:
   - Call `uploadToStage`: `PUT file://tmp @stage/<fileId>/<filename> auto_compress=false overwrite=true`.
   - `persistDocumentRow`: insert `file_id`, `filename`, `stage_path`, chunk count, and metadata into `PDF_DOCUMENTS`.
   - `persistChunks`: loop over chunks. For each chunk, insert row into `PDF_VECTORS` including `chunk_text`, `page_number`, `chunk_index`, and inline embedding: `snowflake.cortex.embed_text_768(?, ?)::vector(float, VECTOR_DIM)` with bind parameters `(env.CORTEX_EMBED_MODEL, chunk.text)`.
5. Delete the temp file and return `IngestSummary` `{ fileId, chunkCount, stagePath, message }`.

Surfaces that reuse this pipeline:
- `/api/upload` (`app/api/upload/route.ts`): multipart endpoint for UI.
- `scripts/ingest-pdf.ts`: headless ingestion CLI (`npm run ingest -- file.pdf`).
- You can import `ingestPdf` directly inside any Node service once env vars are loaded.

## 4. Query ➝ Vector Search ➝ LLM Answer

`queryKnowledgeBase(query, fileId?)` orchestrates retrieval-augmented generation:

1. Ensure infra, then build SQL via `buildVectorSearchSql`:
   ```sql
   with query_embedding as (
     select snowflake.cortex.embed_text_768(?, ?) as embedding
   )
   select
     v.chunk_id,
     v.file_id,
     v.page_number,
     v.chunk_index,
     v.chunk_text,
     v.source_meta,
     vector_cosine_similarity(v.embedding, (select embedding from query_embedding)) as relevance
   from <TABLE_VECTORS> v
   where (? is null or v.file_id = ?)
   order by relevance desc
   limit 5;
   ```
   Parameters: `(env.CORTEX_EMBED_MODEL, query, fileFilter, fileFilter)`.

2. Map result rows into `SourceChunk` objects (`chunkId`, `fileId`, `pageNumber`, `text`, `relevance`, JSON metadata).
3. Build a context block that enumerates each chunk: `Source 1 | chunk_id=... | page=...` + text.
4. Create a prompt (`buildPrompt`) instructing Cortex to answer strictly from context. Invoke `snowflake.cortex.complete(env.CORTEX_LLM_MODEL, prompt)` and parse the answer with `extractCompletion` (works for both plain strings and structured `content`).
5. Return `{ answer, chunks, sql }`. The SQL string is surfaced back to callers for transparency/debugging.

Integrations:
- `/api/query` expects JSON `{ query, fileId? }` and forwards the summary to UIs.
- Other services can call `queryKnowledgeBase` directly to get the final answer + evidence.

## 5. Chunk/Source Retrieval APIs

These helpers expose the stored data for downstream applications:

- `fetchSourceChunk(chunkId)` (`lib/workflows.ts`): fetches `chunk_text`, metadata, and surfaces `stage_path`, enabling deep links to the PDF page.
- `/api/source/[chunkId]`: REST wrapper for the above; used by the `/source/:chunkId` page.
- `fetchDocumentPdf(fileId)` + `/api/documents/[fileId]/pdf`: download the original PDF from the stage via Snowflake `GET`. Response headers include `X-Pdf-Filename` and `X-Pdf-Stage-Path` so clients can show provenance.
- `deleteDocument(fileId)` (`lib/workflows.ts`) + `/api/documents/[fileId]`: remove table rows and staged files in one call (`REMOVE <stage path>`).

## 6. GUI Companion (`snowflake_gui.py`)

For manual exploration, `snowflake_gui.py` provides a Tkinter UI. It reads the same `.env` file to prefill connection fields, allows building SELECT queries, and shows results in a table with filtering/export features. Although separate from the RAG workflow, it proves out the credentials and data access patterns in the same environment.

## 7. How to Reuse in Other Apps

1. **Load env**: Use `dotenv` or your platform secrets and import `env` from `lib/env` to access validated settings.
2. **Call workflows**:
   - Upload/vectorize: `await ingestPdf(buffer, filename)` returning `fileId`, chunk count, stage path.
   - Query: `await queryKnowledgeBase(question, optionalFileId)` returning answer + evidence.
   - Retrieval: `await fetchSourceChunk(chunkId)` or `await fetchDocumentPdf(fileId)` for traceability.
3. **Wrap in your transport**: HTTP endpoints, queues, or cron jobs can call these functions. The heavy lifting (Snowflake SQL, embedding calls, chunking, cleanup) already lives inside `lib/workflows`.
4. **Customize**: Adjust chunk sizes or stage/table names in `.env` without touching code. Swap Cortex models by changing `CORTEX_*` env vars. Update prompt templates in `buildPrompt` if your product needs different instructions.

With this structure, you can integrate the Snowflake upload ➝ vectorize ➝ retrieve flow into any Node.js backend or serverless function simply by importing the shared modules and ensuring environment parity.
