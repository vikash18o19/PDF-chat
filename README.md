## Snowflake PDF Viewer

Stream PDFs directly from a Snowflake stage into a Vite-powered viewer, deep link to specific pages, and highlight text ranges using query parameters.

### Getting Started

1. Ensure the `.env` file at the workspace root holds valid Snowflake credentials (already provided).
2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the full-stack dev server (Express + Vite middleware) on port `8787`:

   ```bash
   npm run dev
   ```

   Visit `http://localhost:8787` and continue to use the query params below. The server also proxies `/api/*` calls to Snowflake.

### Query Parameters

Open the app at `http://localhost:8787` with the following query params:

| Param               | Required | Description                                                                                 |
| ------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `pdf` / `identifier` | ✅       | Path to the staged PDF object (e.g. `reports/quarterly.pdf`).                              |
| `page` / `pageNumber` | ➖     | 1-based page number that should be in view. Defaults to `1`.                                |
| `highlightStart` / `start` | ➖ | Start character index (0-based) on the target page.                                        |
| `highlightEnd` / `end`     | ➖ | End character index (exclusive). Must be greater than `highlightStart`.                    |

Example: `http://localhost:8787/?pdf=reports/sample.pdf&page=2&highlightStart=120&highlightEnd=180`

### Docker

You can also run the viewer in Docker without installing Node locally:

1. Build the image:

   ```bash
   docker build -t snowflake-pdf-viewer .
   ```

2. Start the container, providing all required Snowflake environment variables (or re-use your local `.env` file):

   ```bash
   docker run --rm -p 8787:8787 --env-file .env snowflake-pdf-viewer
   ```

   The server listens on port `8787` inside the container, so the example above exposes it at `http://localhost:8787`.

