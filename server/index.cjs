const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const { Readable } = require('node:stream');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { z } = require('zod');

const {
  ingestPdf,
  queryKnowledgeBase,
  listDocuments,
  extractRelativeStagePath,
  extractStageReferenceFromPath,
} = require('./lib/workflows.cjs');
const { runQuery, STAGE_REFERENCE, TABLE_DOCUMENTS } = require('./lib/snowflake.cjs');

const pdfRequestSchema = z
  .object({
    identifier: z
      .string({
        invalid_type_error: 'pdf identifier must be a string',
      })
      .optional(),
    fileId: z
      .string({
        invalid_type_error: 'fileId must be a string',
      })
      .uuid('fileId must be a valid UUID')
      .optional(),
    stage: z
      .string({
        invalid_type_error: 'stage must be a string',
      })
      .optional(),
  })
  .refine((data) => Boolean(data.identifier || data.fileId), {
    message: 'Provide at least an identifier or fileId.',
    path: ['identifier'],
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

const sanitizeStageReference = (reference) => {
  const trimmed = reference?.trim();
  if (!trimmed) {
    return STAGE_REFERENCE;
  }
  const STAGE_PATTERN = /^@?[\w.]+$/i;
  if (!STAGE_PATTERN.test(trimmed)) {
    const error = new Error('Stage reference contains unsupported characters.');
    error.statusCode = 400;
    throw error;
  }
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
};

const parseVariant = (value) => {
  if (!value) {
    return {};
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') {
    return value;
  }
  return {};
};

const fetchDocumentPointer = async (fileId) => {
  if (!fileId) {
    return null;
  }
  const rows = await runQuery(
    `select FILE_ID, FILENAME, STAGE_PATH, STAGE_REFERENCE, METADATA from ${TABLE_DOCUMENTS} where FILE_ID = ? limit 1`,
    [fileId],
  );
  if (!rows?.length) {
    return null;
  }
  const doc = rows[0];
  const meta = parseVariant(doc.METADATA);
  return {
    fileId: doc.FILE_ID || meta.fileId || fileId,
    filename: doc.FILENAME || meta.filename || 'document.pdf',
    stagePath: extractRelativeStagePath(doc.STAGE_PATH || meta.stagePath) || null,
    stageReference:
      doc.STAGE_REFERENCE ||
      meta.stageReference ||
      extractStageReferenceFromPath(doc.STAGE_PATH || meta.stagePath) ||
      null,
  };
};

const LEGACY_FLAT_IDENTIFIER = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/i;

const extractLegacyTailInfo = (identifier) => {
  if (!identifier || typeof identifier !== 'string') {
    return null;
  }
  const tail = identifier.trim().split('/').filter(Boolean).pop();
  if (!tail) {
    return null;
  }
  const match = tail.match(LEGACY_FLAT_IDENTIFIER);
  if (!match) {
    return null;
  }
  return { fileId: match[1], filename: match[2] };
};

const buildLegacyCandidateIdentifier = (identifier, pointer) => {
  if (!identifier) {
    return null;
  }
  const trimmed = identifier.trim().replace(/\/+$/, '');
  if (!trimmed.includes('/')) {
    return null;
  }
  const segments = trimmed.split('/');
  if (segments.length < 2) {
    return null;
  }
  const fallbackId = pointer?.fileId || segments[segments.length - 2];
  const fallbackName = pointer?.filename || segments[segments.length - 1];
  if (!fallbackId || !fallbackName) {
    return null;
  }
  const legacySuffix = `${fallbackId}-${fallbackName}`;
  if (trimmed.endsWith(`/${legacySuffix}`)) {
    return null;
  }
  return `${trimmed}/${legacySuffix}`;
};

const buildStageCandidates = ({ pointer, requestIdentifier, requestStage }) => {
  const candidates = [];
  const seen = new Set();
  const defaultStage = pointer?.stageReference ?? requestStage ?? STAGE_REFERENCE;
  const addCandidate = (identifier, stageRef) => {
    if (!identifier) return;
    const trimmed = identifier.trim();
    if (!trimmed) return;
    const resolvedStage = sanitizeStageReference(stageRef ?? defaultStage);
    const key = `${resolvedStage}::${trimmed}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ identifier: trimmed, stageReference: resolvedStage });
  };

  const addCanonicalVariants = (fileId, filename, stageRef) => {
    if (!fileId || !filename) {
      return;
    }
    const canonical = `${fileId}/${filename}`;
    addCandidate(canonical, stageRef);
    addCandidate(`${canonical}/${fileId}-${filename}`, stageRef);
  };

  if (requestIdentifier) {
    addCandidate(requestIdentifier, requestStage);
    const legacyFromRequest = buildLegacyCandidateIdentifier(requestIdentifier, pointer);
    if (legacyFromRequest) {
      addCandidate(legacyFromRequest, requestStage);
    }
    const inferred = extractLegacyTailInfo(requestIdentifier);
    if (inferred) {
      addCanonicalVariants(inferred.fileId, inferred.filename, requestStage);
    }
  }

  if (pointer?.stagePath) {
    addCandidate(pointer.stagePath, pointer.stageReference);
    const legacyFromPointer = buildLegacyCandidateIdentifier(pointer.stagePath, pointer);
    if (legacyFromPointer) {
      addCandidate(legacyFromPointer, pointer.stageReference);
    }
  }

  if (pointer?.fileId && pointer?.filename) {
    addCanonicalVariants(pointer.fileId, pointer.filename, pointer.stageReference);
  }

  return candidates;
};

const createPresignedUrl = async ({ stageReference, identifier }) => {
  const stageRef = sanitizeStageReference(stageReference ?? STAGE_REFERENCE);
  const safeIdentifier = sanitizeIdentifier(identifier);
  const escapedIdentifier = safeIdentifier.replace(/'/g, "''");

  const rows = await runQuery(
    `SELECT GET_PRESIGNED_URL(${stageRef}, '${escapedIdentifier}', 3600) AS URL`,
  );

  if (!rows?.length || !rows[0].URL) {
    throw new Error(`Unable to create presigned URL for ${safeIdentifier}`);
  }

  return {
    url: rows[0].URL,
    identifier: safeIdentifier,
    stageReference: stageRef,
  };
};

const streamPdfToResponse = async ({ stageReference, identifier, fileId, res }) => {
  const pointer = await fetchDocumentPointer(fileId);
  const stageCandidates = buildStageCandidates({
    pointer,
    requestIdentifier: identifier,
    requestStage: stageReference,
  });

  if (!stageCandidates.length) {
    throw new Error('Document identifier is missing.');
  }

  let lastError;
  for (const candidate of stageCandidates) {
    try {
      const { url, identifier: resolvedIdentifier, stageReference: resolvedStage } = await createPresignedUrl(
        candidate,
      );
      const pdfResponse = await fetch(url);
      if (!pdfResponse.ok || !pdfResponse.body) {
        throw new Error(`Stage download failed with ${pdfResponse.status} ${pdfResponse.statusText}`);
      }

      const downloadName = pointer?.filename || resolvedIdentifier.split('/').pop() || 'document.pdf';

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
      res.setHeader('X-Pdf-Filename', downloadName);
      if (pointer?.fileId) {
        res.setHeader('X-Pdf-File-Id', pointer.fileId);
      }
      res.setHeader('X-Pdf-Stage-Path', resolvedIdentifier);
      res.setHeader('X-Pdf-Stage-Reference', resolvedStage);

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
      return;
    } catch (error) {
      lastError = error;
      console.warn('Attempt to stream PDF failed, trying next candidate', {
        candidate,
        error: error?.message,
      });
    }
  }

  throw lastError ?? new Error('Unable to retrieve PDF from Snowflake stage. Double-check the identifier and try again.');
};

const queryRequestSchema = z.object({
  question: z
    .string({
      required_error: 'Question is required',
      invalid_type_error: 'Question must be a string',
    })
    .min(1, 'Question cannot be empty'),
  fileIds: z
    .array(z.string().min(1))
    .max(8)
    .optional()
    .default([]),
  topK: z.coerce.number().int().min(1).max(10).optional(),
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 5,
  },
});

const app = express();
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/documents', async (_req, res) => {
  try {
    const documents = await listDocuments();
    res.json({ documents });
  } catch (error) {
    console.error('Failed to list documents', error);
    res.status(500).json({ message: 'Unable to load documents from Snowflake.' });
  }
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) {
    return res.status(400).json({ message: 'Attach at least one PDF.' });
  }

  const successes = [];
  try {
    for (const file of files) {
      if (file.mimetype !== 'application/pdf') {
        throw new Error(`"${file.originalname}" is not a PDF.`);
      }
      const summary = await ingestPdf(file.buffer, file.originalname);
      successes.push(summary);
    }
    res.json({ documents: successes });
  } catch (error) {
    console.error('Failed to ingest PDF', error);
    const message = error?.message || 'Failed to upload PDF.';
    res.status(500).json({
      message,
      documents: successes,
    });
  }
});

app.post('/api/query', async (req, res) => {
  const parsed = queryRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Invalid request',
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }

  try {
    const { question, fileIds, topK } = parsed.data;
    const summary = await queryKnowledgeBase({ question, fileIds, topK });
    res.json(summary);
  } catch (error) {
    console.error('Failed to query knowledge base', error);
    res.status(500).json({ message: error?.message || 'Unable to run the question against Snowflake.' });
  }
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
    await streamPdfToResponse({
      stageReference: parsed.data.stage,
      identifier: parsed.data.identifier ?? undefined,
      fileId: parsed.data.fileId ?? undefined,
      res,
    });
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
