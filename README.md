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

### OCI Terraform VM

Provision a compute instance on Oracle Cloud Infrastructure using the Terraform config in `infra/main.tf`:

1. Export (or provide via `terraform.tfvars`) the required OCI credentials: `tenancy_ocid`, `user_ocid`, `api_key_fingerprint`, `api_private_key_path`, `region`, `compartment_ocid`, and your `ssh_public_key`.
2. Initialize and apply:

   ```bash
   cd infra
   terraform init
   terraform apply
   ```

   The plan creates a small VCN, public subnet, and a single flexible VM (`VM.Standard.A1.Flex` by default) with port `8787` exposed so you can deploy this PDF viewer on the instance once it boots. If Oracle Linux image lookup fails in your region, either set `image_ocid` to a known image ID or tweak `oracle_linux_version` in `terraform.tfvars`. For regions with limited capacity, override `shape` (and optionally `availability_domain`) in `terraform.tfvars` to a shape/AD that has quota in your tenancy.

### Production Notes

- `VITE_API_BASE_URL` can be set to an absolute URL when the frontend and backend live on different hosts.
- The Express server exposes `GET /api/pdf?identifier=<path>` which fetches a presigned URL via `GET_PRESIGNED_URL`, then streams the PDF back to the browser.
- Keep Snowflake credentials on the server only; the frontend never accesses them.
