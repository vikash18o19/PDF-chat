const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { chunkPdf } = require('./pdf.cjs');
const { env, STAGE_REFERENCE, TABLE_DOCUMENTS, TABLE_VECTORS } = require('./env.cjs');
const { execute, withSnowflakeConnection } = require('./snowflake.cjs');

const tmpRoot = os.tmpdir();

const sanitizeFilename = (filename) => {
  const fallback = 'document.pdf';
  if (!filename || typeof filename !== 'string') {
    return fallback;
  }
  const trimmed = filename.trim().toLowerCase();
  const safe = trimmed.replace(/[^a-z0-9.\-_ ]/gi, '-').replace(/\s+/g, '-');
  const finalName = safe.length ? safe : fallback;
  return finalName.endsWith('.pdf') ? finalName : `${finalName}.pdf`;
};

const writeTempPdf = async (buffer, filename) => {
  const dir = await fs.mkdtemp(path.join(tmpRoot, 'ai-pdf-'));
  const tempPath = path.join(dir, filename);
  await fs.writeFile(tempPath, buffer);
  return tempPath;
};

const extractRelativeStagePath = (value) => {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith('@')) {
    const slashIndex = normalized.indexOf('/');
    return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : null;
  }
  const protocolIndex = normalized.indexOf('://');
  if (protocolIndex >= 0) {
    const firstSlash = normalized.indexOf('/', protocolIndex + 3);
    if (firstSlash >= 0) {
      return normalized.slice(firstSlash + 1);
    }
    return null;
  }
  return normalized;
};

const extractStageReferenceFromPath = (value) => {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('@')) {
    return null;
  }
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex >= 0) {
    return trimmed.slice(0, slashIndex);
  }
  return trimmed;
};

const uploadToStage = async (connection, localPath, stagePrefix = '') => {
  const escapedLocalPath = localPath.replace(/\\/g, '/').replace(/'/g, "''");
  const normalizedPrefix = stagePrefix.replace(/^\/+|\/+$/g, '');
  const stageTarget = normalizedPrefix ? `${STAGE_REFERENCE}/${normalizedPrefix}` : STAGE_REFERENCE;
  const sqlText = `put file://${escapedLocalPath} ${stageTarget} auto_compress=false overwrite=true`;
  const rows = await execute(connection, { sqlText });
  const target = rows?.[0]?.target || rows?.[0]?.TARGET;
  const resolvedTarget = extractRelativeStagePath(target);
  const baseName =
    (resolvedTarget && resolvedTarget.split('/').pop()) ||
    (typeof target === 'string' ? target.split('/').pop() : null) ||
    path.basename(localPath);
  const safeName = baseName?.trim() ? baseName.trim() : path.basename(localPath);
  return normalizedPrefix ? `${normalizedPrefix}/${safeName}` : safeName;
};

const persistDocument = async (connection, { fileId, filename, stagePath, chunkCount }) => {
  const metadata = {
    fileId,
    filename,
    stagePath,
    chunkCount,
    stageReference: STAGE_REFERENCE,
  };
  await execute(connection, {
    sqlText: `
      insert into ${TABLE_DOCUMENTS} (FILE_ID, FILENAME, STAGE_PATH, CHUNK_COUNT, METADATA, STAGE_REFERENCE, CREATED_AT)
      select ?, ?, ?, ?, parse_json(?), ?, current_timestamp()
    `,
    binds: [fileId, filename, stagePath, chunkCount, JSON.stringify(metadata), STAGE_REFERENCE],
  });
};

const persistChunks = async (connection, { fileId, filename, stagePath, chunks }) => {
  let chunkOrder = 0;
  for (const chunk of chunks) {
    const chunkId = randomUUID();
    const chunkMeta = {
      pageNumber: chunk.pageNumber,
      charStart: chunk.pageCharStart,
      charEnd: chunk.pageCharEnd,
      stagePath,
      stageReference: STAGE_REFERENCE,
      filename,
    };

    await execute(connection, {
      sqlText: `
        insert into ${TABLE_VECTORS} (
          CHUNK_ID,
          FILE_ID,
          PAGE_NUMBER,
          CHUNK_INDEX,
          CHUNK_TEXT,
          CHAR_START,
          CHAR_END,
          SOURCE_META,
          EMBEDDING,
          CREATED_AT
        )
        select
          ?, ?, ?, ?, ?, ?, ?, parse_json(?),
          snowflake.cortex.embed_text_768(?, ?)::vector(float, ${env.VECTOR_DIM}),
          current_timestamp()
      `,
      binds: [
        chunkId,
        fileId,
        chunk.pageNumber,
        chunkOrder,
        chunk.normalizedText,
        chunk.pageCharStart,
        chunk.pageCharEnd,
        JSON.stringify(chunkMeta),
        env.CORTEX_EMBED_MODEL,
        chunk.normalizedText,
        // created_at via select uses current_timestamp, so no bind
      ],
    });

    chunkOrder += 1;
  }
};

const cleanupTempFile = async (filePath) => {
  if (!filePath) return;
  try {
    const dir = path.dirname(filePath);
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn('Failed to cleanup temp PDF', error);
  }
};

const ingestPdf = async (buffer, originalName) => {
  const filename = sanitizeFilename(originalName);
  const fileId = randomUUID();
  const stageFolder = fileId;
  const intendedStagePath = `${stageFolder}/${filename}`;
  let resolvedStagePath = intendedStagePath;

  const chunks = await chunkPdf(buffer);
  if (!chunks.length) {
    throw new Error('Unable to extract readable text from the PDF.');
  }

  const tempFilePath = await writeTempPdf(buffer, filename);

  try {
    await withSnowflakeConnection(async (connection) => {
      resolvedStagePath = await uploadToStage(connection, tempFilePath, stageFolder);
      await persistDocument(connection, {
        fileId,
        filename,
        stagePath: resolvedStagePath,
        chunkCount: chunks.length,
      });
      await persistChunks(connection, {
        fileId,
        filename,
        stagePath: resolvedStagePath,
        chunks,
      });
      return resolvedStagePath;
    });
  } finally {
    await cleanupTempFile(tempFilePath);
  }

  return {
    fileId,
    filename,
    stagePath: resolvedStagePath,
    chunkCount: chunks.length,
  };
};

const parseSourceMeta = (meta) => {
  if (!meta) return {};
  if (typeof meta === 'string') {
    try {
      return JSON.parse(meta);
    } catch {
      return {};
    }
  }
  if (typeof meta === 'object') {
    return meta;
  }
  return {};
};

const buildPrompt = (question, chunks) => {
  const header =
    'You are an expert AI assistant that answers user questions strictly using the provided context snippets extracted from PDF documents.\n' +
    'Cite the PDFs naturally (e.g., "Page 2 · Quarterly Results") when referencing a chunk. If the answer is not in context, say you do not know.';
  const context = chunks
    .map(
      (chunk, index) =>
        `Source ${index + 1} | chunk_id=${chunk.chunkId} | page=${chunk.pageNumber} | file=${chunk.fileName}\n${chunk.text}`,
    )
    .join('\n\n');

  return `${header}\n\nContext:\n${context}\n\nQuestion: ${question}\nAnswer:`;
};

const extractCompletion = (value) => {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.choices) && value.choices.length) {
      const first = value.choices[0];
      if (first?.message?.content) {
        if (Array.isArray(first.message.content)) {
          return first.message.content.map((chunk) => chunk.text || '').join('').trim();
        }
        if (typeof first.message.content === 'string') {
          return first.message.content.trim();
        }
      }
    }
    if ('response' in value && typeof value.response === 'string') {
      return value.response.trim();
    }
    if ('content' in value) {
      const content = value.content;
      if (typeof content === 'string') {
        return content.trim();
      }
      if (Array.isArray(content)) {
        return content.map((chunk) => (typeof chunk === 'string' ? chunk : chunk?.text || '')).join('').trim();
      }
    }
  }
  return '';
};

const mapChunkRow = (row) => {
  const meta = parseSourceMeta(row.SOURCE_META);
  return {
    chunkId: row.CHUNK_ID,
    fileId: row.FILE_ID,
    fileName: row.FILENAME,
      stagePath: extractRelativeStagePath(row.STAGE_PATH || meta.stagePath),
    stageReference:
      row.STAGE_REFERENCE ||
      meta.stageReference ||
      extractStageReferenceFromPath(row.STAGE_PATH || meta.stagePath) ||
      STAGE_REFERENCE,
    pageNumber: Number(row.PAGE_NUMBER),
    chunkIndex: Number(row.CHUNK_INDEX),
    text: row.CHUNK_TEXT,
    relevance: Number(row.RELEVANCE ?? row.SCORE ?? 0),
    highlightStart: Number(row.CHAR_START ?? meta.charStart ?? 0),
    highlightEnd: Number(row.CHAR_END ?? meta.charEnd ?? 0),
  };
};

const queryKnowledgeBase = async ({ question, fileIds = [], topK = 5 }) => {
  if (!question || !question.trim()) {
    throw new Error('Question cannot be empty.');
  }

  return withSnowflakeConnection(async (connection) => {
    const filters = [];
    const binds = [env.CORTEX_EMBED_MODEL, question];

    if (Array.isArray(fileIds) && fileIds.length > 0) {
      const placeholders = fileIds.map(() => '?').join(', ');
      filters.push(`and v.file_id in (${placeholders})`);
      binds.push(...fileIds);
    }

    const sqlText = `
      with query_embedding as (
        select snowflake.cortex.embed_text_768(?, ?) as embedding
      )
      select
        v.CHUNK_ID,
        v.FILE_ID,
        v.PAGE_NUMBER,
        v.CHUNK_INDEX,
        v.CHUNK_TEXT,
        v.CHAR_START,
        v.CHAR_END,
        v.SOURCE_META,
        d.FILENAME,
        d.STAGE_PATH,
        d.STAGE_REFERENCE,
        vector_cosine_similarity(v.EMBEDDING, (select embedding from query_embedding)) as RELEVANCE
      from ${TABLE_VECTORS} v
      join ${TABLE_DOCUMENTS} d on d.FILE_ID = v.FILE_ID
      where 1=1
      ${filters.join('\n')}
      order by RELEVANCE desc
      limit ${Math.max(1, Math.min(topK, 10))}
    `;

    const rows = await execute(connection, { sqlText, binds });
    const chunks = rows.map(mapChunkRow);
    if (!chunks.length) {
      return { answer: 'No relevant results found in the selected PDFs.', chunks: [] };
    }

    const prompt = buildPrompt(question, chunks);
    const completionRows = await execute(connection, {
      sqlText: 'select snowflake.cortex.complete(?, ?) as RESPONSE',
      binds: [env.CORTEX_LLM_MODEL, prompt],
    });
    const answer = extractCompletion(completionRows[0]?.RESPONSE) || 'No answer generated.';
    return { answer, chunks };
  });
};

const listDocuments = async () => {
  return withSnowflakeConnection(async (connection) => {
    const rows = await execute(connection, {
      sqlText: `
        select FILE_ID, FILENAME, STAGE_PATH, STAGE_REFERENCE, CHUNK_COUNT, CREATED_AT
        from ${TABLE_DOCUMENTS}
        order by CREATED_AT desc
      `,
    });

    return rows.map((row) => ({
      fileId: row.FILE_ID,
      filename: row.FILENAME,
      stagePath: extractRelativeStagePath(row.STAGE_PATH),
      stageReference:
        row.STAGE_REFERENCE ||
        extractStageReferenceFromPath(row.STAGE_PATH) ||
        STAGE_REFERENCE,
      chunkCount: Number(row.CHUNK_COUNT ?? 0),
      createdAt: row.CREATED_AT,
    }));
  });
};

module.exports = {
  ingestPdf,
  listDocuments,
  queryKnowledgeBase,
  extractRelativeStagePath,
  extractStageReferenceFromPath,
};
