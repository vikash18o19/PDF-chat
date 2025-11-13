const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');
const snowflake = require('snowflake-sdk');
const { Readable } = require('node:stream');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { z } = require('zod');

dotenv.config();

const {
  SNOWFLAKE_ACCOUNT,
  SNOWFLAKE_USER,
  SNOWFLAKE_PASSWORD,
  SNOWFLAKE_ROLE,
  SNOWFLAKE_WAREHOUSE,
  SNOWFLAKE_DATABASE,
  SNOWFLAKE_SCHEMA,
  SNOWFLAKE_STAGE,
} = process.env;

const ensureEnv = (value, key) => {
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const connectionConfig = {
  account: ensureEnv(SNOWFLAKE_ACCOUNT, 'SNOWFLAKE_ACCOUNT'),
  username: ensureEnv(SNOWFLAKE_USER, 'SNOWFLAKE_USER'),
  password: ensureEnv(SNOWFLAKE_PASSWORD, 'SNOWFLAKE_PASSWORD'),
  role: ensureEnv(SNOWFLAKE_ROLE, 'SNOWFLAKE_ROLE'),
  warehouse: ensureEnv(SNOWFLAKE_WAREHOUSE, 'SNOWFLAKE_WAREHOUSE'),
  database: ensureEnv(SNOWFLAKE_DATABASE, 'SNOWFLAKE_DATABASE'),
  schema: ensureEnv(SNOWFLAKE_SCHEMA, 'SNOWFLAKE_SCHEMA'),
};

const stageReferenceRaw = ensureEnv(SNOWFLAKE_STAGE, 'SNOWFLAKE_STAGE').trim();
const stageReference = stageReferenceRaw.startsWith('@')
  ? stageReferenceRaw
  : `@${stageReferenceRaw}`;

const pdfRequestSchema = z.object({
  identifier: z
    .string({
      required_error: 'pdf identifier is required',
      invalid_type_error: 'pdf identifier must be a string',
    })
    .min(1, 'pdf identifier cannot be empty'),
});

const IDENTIFIER_PATTERN = /^[\w.\-\/ ]+$/i;

const sanitizeIdentifier = (identifier) => {
  const trimmed = identifier.trim();
  if (!IDENTIFIER_PATTERN.test(trimmed)) {
    const error = new Error(
      'Identifier contains unsupported characters. Use alphanumerics, "/", ".", "-", "_" or spaces.',
    );
    error.statusCode = 400;
    throw error;
  }

  if (trimmed.includes('..')) {
    const error = new Error('Identifier cannot contain ".." sequences.');
    error.statusCode = 400;
    throw error;
  }

  return trimmed;
};

const runQuery = (sqlText, binds = []) =>
  new Promise((resolve, reject) => {
    const connection = snowflake.createConnection(connectionConfig);

    connection.connect((connectErr) => {
      if (connectErr) {
        return reject(connectErr);
      }

      connection.execute({
        sqlText,
        binds,
        complete: (execErr, stmt, rows) => {
          connection.destroy((destroyErr) => {
            if (destroyErr) {
              console.error('Failed to release Snowflake connection', destroyErr);
            }
          });

          if (execErr) {
            return reject(execErr);
          }

          resolve(rows);
        },
      });
    });
  });

const getPresignedUrl = async (rawIdentifier) => {
  const safeIdentifier = sanitizeIdentifier(rawIdentifier);
  const escapedIdentifier = safeIdentifier.replace(/'/g, "''");

  const rows = await runQuery(
    `SELECT GET_PRESIGNED_URL(${stageReference}, '${escapedIdentifier}', 3600) AS URL`,
  );

  if (!rows?.length || !rows[0].URL) {
    throw new Error(`Unable to create presigned URL for ${safeIdentifier}`);
  }

  return rows[0].URL;
};

const streamPdfToResponse = async ({ identifier, res }) => {
  const presignedUrl = await getPresignedUrl(identifier);
  const pdfResponse = await fetch(presignedUrl);

  if (!pdfResponse.ok || !pdfResponse.body) {
    throw new Error(`Failed to download PDF: ${pdfResponse.status} ${pdfResponse.statusText}`);
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store');
  const filename = identifier.split('/').pop() || 'document.pdf';
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

  if (typeof pdfResponse.body.pipe === 'function') {
    pdfResponse.body.pipe(res);
    return;
  }

  if (Readable.fromWeb) {
    const nodeReadable = Readable.fromWeb(pdfResponse.body);
    nodeReadable.on('error', (err) => {
      console.error('Streaming error from Snowflake presigned URL', err);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Failed to stream PDF' });
      } else {
        res.end();
      }
    });
    nodeReadable.pipe(res);
    return;
  }

  const buffer = Buffer.from(await pdfResponse.arrayBuffer());
  res.end(buffer);
};

const app = express();
app.use(cors());
app.use(morgan('dev'));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/pdf', async (req, res) => {
  const parsed = pdfRequestSchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({
      message: 'Invalid request',
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }

  try {
    await streamPdfToResponse({ identifier: parsed.data.identifier, res });
  } catch (error) {
    console.error('Failed to serve PDF', error);
    const statusCode = error?.statusCode ?? 502;
    const message =
      statusCode === 400
        ? error.message
        : 'Unable to retrieve PDF from Snowflake stage. Double-check the identifier and try again.';
    return res.status(statusCode).json({ message });
  }
});

const startServer = async () => {
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        configFile: path.resolve(__dirname, '../vite.config.ts'),
        server: {
          middlewareMode: true,
          hmr: {
            server: httpServer,
          },
        },
      });
      app.use(vite.middlewares);
    } catch (error) {
      console.error('Failed to start Vite dev middleware', error);
      process.exit(1);
    }
  } else {
    const distPath = path.resolve(__dirname, '../dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.use((req, res, next) => {
        if (req.path.startsWith('/api') || req.method !== 'GET') {
          return next();
        }
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  const PORT = process.env.PORT || 8787;
  httpServer.listen(PORT, () => {
    console.log(`API server listening on http://localhost:${PORT}`);
  });
};

startServer().catch((error) => {
  console.error('Server failed to start', error);
  process.exit(1);
});
