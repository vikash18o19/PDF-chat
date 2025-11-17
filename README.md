# PDF-Chat

Vite + React front-end plus an Express API that stores PDFs, chunks, and embeddings inside Snowflake. Use it to upload a PDF, ask questions against the stored content, and preview the relevant page with highlights.

## Prerequisites

- Node.js 20+
- A Snowflake account with Cortex enabled and credentials stored in the root `.env`
- Docker (optional) when packaging

Important environment variables (see `server/lib/env.cjs`): `SNOWFLAKE_*`, `CORTEX_EMBED_MODEL`, `CORTEX_LLM_MODEL`, `VECTOR_DIM`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, and optional `VITE_API_BASE_URL` when the UI and API live on different origins.

## Local Development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Launch the combined dev server (Express + Vite middleware) on `http://localhost:8787`:

   ```bash
   npm run dev
   ```

   The UI is served from Vite, while all `/api/*` calls are handled by Express and proxied to Snowflake.

Useful variations:

- `npm run dev:client` – run only the Vite UI (requires `VITE_API_BASE_URL` pointing at an already running server).
- `npm run server` – run the Express API without Vite; ideal when you already built the client.

## Working on the Backend

- Entry point: `server/index.cjs`. This file wires up Express, multer uploads, the Snowflake helper, and the `/api` routes (`/api/upload`, `/api/documents`, `/api/query`, `/api/pdf`).
- Core workflows live in `server/lib/workflows.cjs`. `ingestPdf` uploads to the Snowflake stage and persists metadata + embeddings; `queryKnowledgeBase` runs similarity search and calls Cortex for the answer.
- Snowflake access is centralized in `server/lib/snowflake.cjs` with `withSnowflakeConnection`, infrastructure bootstrap, and helpers for presigned URLs.
- When making minor backend changes, run `npm run server` and hit the routes with curl or Postman. Logs stream to your terminal via `morgan` and console statements.

## Working on the UI

- Main UI code: `src/App.tsx`. It contains document upload, selection, querying, PDF rendering (`react-pdf`), highlighting, zoom, and theme toggles.
- Styling lives in `src/App.css` plus the bundled `react-pdf` layer CSS.
- The UI reads `VITE_API_BASE_URL` to know where to send API calls. During local dev, it defaults to the same origin (`http://localhost:8787`).
- For quick tweaks, start `npm run dev`, edit the React components, and Vite will hot-reload without restarting the server.

## Deployment

1. Build the React client + TypeScript output:

   ```bash
   npm run build
   ```

2. Start the production server (serves `/dist` and the API):

   ```bash
   NODE_ENV=production PORT=8787 npm run server
   ```

3. Alternatively, package everything via Docker:

   ```bash
   docker build -t pdf-viewer .
   docker run --env-file .env -p 8787:8787 pdf-viewer
   ```

Ensure the container or host is supplied with the same Snowflake and Cortex variables listed above. Only the backend should have direct access to those secrets; the client communicates exclusively with the Express API.
