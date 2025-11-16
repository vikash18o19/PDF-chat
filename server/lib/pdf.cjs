const { PDFParse } = require('pdf-parse');
const { env } = require('./env.cjs');

const ITEM_GAP_MARKER = /\s+/g;

const chunkPageText = ({ text, pageNumber, chunkSize, chunkOverlap, startIndexOffset }) => {
  const chunks = [];
  const totalLength = text.length;
  if (!totalLength) {
    return chunks;
  }

  let cursor = 0;
  let chunkIndex = startIndexOffset;
  const overlap = Math.min(chunkOverlap, Math.max(chunkSize - 1, 0));

  while (cursor < totalLength) {
    const chunkEnd = Math.min(cursor + chunkSize, totalLength);
    const rawSlice = text.slice(cursor, chunkEnd);
    const normalized = rawSlice.replace(ITEM_GAP_MARKER, ' ').trim();
    if (normalized.length > 0) {
      chunks.push({
        chunkIndex,
        pageNumber,
        rawText: rawSlice,
        normalizedText: normalized,
        pageCharStart: cursor,
        pageCharEnd: chunkEnd,
      });
      chunkIndex += 1;
    }

    if (chunkEnd >= totalLength) {
      break;
    }
    cursor = Math.max(chunkEnd - overlap, 0);
  }

  return chunks;
};

const chunkPdf = async (buffer) => {
  const parser = new PDFParse({ data: buffer });
  let textResult;
  try {
    textResult = await parser.getText();
  } finally {
    try {
      await parser.destroy();
    } catch (error) {
      console.warn('Failed to cleanup PDF parser', error);
    }
  }

  const pages = Array.isArray(textResult?.pages) ? textResult.pages : [];
  if (!pages.length) {
    return [];
  }

  const chunkSize = env.CHUNK_SIZE;
  const chunkOverlap = env.CHUNK_OVERLAP;
  const chunks = [];

  pages.forEach((pageResult) => {
    const pageNumber = pageResult?.num ?? chunks.length + 1;
    const pageText = typeof pageResult?.text === 'string' ? pageResult.text : '';
    if (!pageText.trim()) {
      return;
    }
    const pageChunks = chunkPageText({
      text: pageText,
      pageNumber,
      chunkSize,
      chunkOverlap,
      startIndexOffset: chunks.length,
    });
    chunks.push(...pageChunks);
  });

  return chunks;
};

module.exports = {
  chunkPdf,
};
