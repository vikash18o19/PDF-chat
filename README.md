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

Open the app at `http://localhost:5173` with the following query params:

| Param               | Required | Description                                                                                 |
| ------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `pdf` / `identifier` | ✅       | Path to the staged PDF object (e.g. `reports/quarterly.pdf`).                              |
| `page` / `pageNumber` | ➖     | 1-based page number that should be in view. Defaults to `1`.                                |
| `highlightStart` / `start` | ➖ | Start character index (0-based) on the target page.                                        |
| `highlightEnd` / `end`     | ➖ | End character index (exclusive). Must be greater than `highlightStart`.                    |

Example: `http://localhost:5173/?pdf=reports/sample.pdf&page=2&highlightStart=120&highlightEnd=180`

### Production Notes

- `VITE_API_BASE_URL` can be set to an absolute URL when the frontend and backend live on different hosts.
- The Express server exposes `GET /api/pdf?identifier=<path>` which fetches a presigned URL via `GET_PRESIGNED_URL`, then streams the PDF back to the browser.
- Keep Snowflake credentials on the server only; the frontend never accesses them.
