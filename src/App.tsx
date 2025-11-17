import type { ChangeEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { DocumentProps, PageProps } from 'react-pdf';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';

import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import './App.css';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

type HighlightRange = { start: number; end: number };

type DocumentSummary = {
  fileId: string;
  filename: string;
  stagePath: string;
  stageReference: string;
  chunkCount: number;
  createdAt?: string;
};

type SourceChunk = {
  chunkId: string;
  fileId: string;
  fileName: string;
  stagePath: string;
  stageReference: string;
  pageNumber: number;
  chunkIndex: number;
  text: string;
  relevance: number;
  highlightStart: number;
  highlightEnd: number;
};

type ViewerConfig = {
  identifier: string;
  stageReference: string;
  fileId: string;
  page: number;
  highlight: HighlightRange | null;
};

type ViewerStatus = 'idle' | 'loading' | 'ready';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const isTextItem = (item: TextContent['items'][number]): item is TextItem =>
  Boolean(item && typeof item === 'object' && 'str' in item);

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const formatTimestamp = (input?: string) => {
  if (!input) return '—';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.15;
const THEME_STORAGE_KEY = 'pdf-viewer-theme';

type ThemeMode = 'light' | 'dark';

const getPreferredTheme = (): ThemeMode => {
  if (typeof window === 'undefined') {
    return 'dark';
  }
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
};

function App() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [selectedDocuments, setSelectedDocuments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceChunk[]>([]);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [viewerConfig, setViewerConfig] = useState<ViewerConfig | null>(null);
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus>('idle');
  const [viewerMessage, setViewerMessage] = useState<string | null>('Select a chunk to preview the PDF.');
  const [documentSource, setDocumentSource] = useState<DocumentProps['file']>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [viewerWidth, setViewerWidth] = useState(() => {
    const width = typeof window !== 'undefined' ? window.innerWidth : 900;
    return clamp(width - 80, 320, 1200);
  });
  const [activeChunkId, setActiveChunkId] = useState<string | null>(null);
  const textSegmentMapRef = useRef<Map<number, Map<number, { start: number; end: number }>>>(new Map());
  const pageRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const pagesContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerStageRef = useRef<HTMLDivElement | null>(null);
  const hasAutoScrolledRef = useRef(false);
  const [textLayerVersion, setTextLayerVersion] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [theme, setTheme] = useState<ThemeMode>(() => getPreferredTheme());

  const selectedSet = useMemo(() => new Set(selectedDocuments), [selectedDocuments]);
  const isDarkMode = theme === 'dark';

  const refreshDocuments = useCallback(async () => {
    setDocumentsLoading(true);
    setDocumentsError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/api/documents`);
      if (!response.ok) {
        throw new Error('Unable to reach the Snowflake document catalog.');
      }
      const payload = await response.json();
      setDocuments(Array.isArray(payload?.documents) ? payload.documents : []);
    } catch (error) {
      setDocumentsError(error instanceof Error ? error.message : 'Failed to load documents.');
      setDocuments([]);
    } finally {
      setDocumentsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshDocuments();
  }, [refreshDocuments]);

  useEffect(() => {
    setSelectedDocuments((current) => current.filter((id) => documents.some((doc) => doc.fileId === id)));
  }, [documents]);

  useEffect(() => {
    setZoomLevel(1);
  }, [viewerConfig?.identifier]);

  const handleFileSelection = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) {
        return;
      }

      const formData = new FormData();
      Array.from(files).forEach((file) => formData.append('files', file));

      setUploading(true);
      setUploadError(null);
      try {
        const response = await fetch(`${apiBaseUrl}/api/upload`, {
          method: 'POST',
          body: formData,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.message || 'Upload failed. Please try again.');
        }
        await refreshDocuments();
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : 'Unable to upload the selected PDFs.');
      } finally {
        setUploading(false);
        event.target.value = '';
      }
    },
    [refreshDocuments],
  );

  const toggleDocumentSelection = useCallback((fileId: string) => {
    setSelectedDocuments((current) =>
      current.includes(fileId) ? current.filter((id) => id !== fileId) : [...current, fileId],
    );
  }, []);

  const handleAskQuestion = useCallback(async () => {
    if (!question.trim() || selectedDocuments.length === 0) {
      return;
    }

    setQueryLoading(true);
    setQueryError(null);
    setAnswer(null);
    setSources([]);
    setViewerConfig(null);
    setActiveChunkId(null);
    setViewerMessage('Select a chunk to preview the PDF.');

    try {
      const response = await fetch(`${apiBaseUrl}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          fileIds: selectedDocuments,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.message || 'Request failed. Try again.');
      }
      setAnswer(payload?.answer ?? 'No answer returned.');
      setSources(Array.isArray(payload?.chunks) ? payload.chunks : []);
    } catch (error) {
      setQueryError(error instanceof Error ? error.message : 'Unable to reach the AI endpoint.');
    } finally {
      setQueryLoading(false);
    }
  }, [question, selectedDocuments]);

  const handleChunkSelect = useCallback((chunk: SourceChunk) => {
    if (!chunk?.stagePath) {
      return;
    }
    const highlight =
      Number.isFinite(chunk.highlightStart) &&
      Number.isFinite(chunk.highlightEnd) &&
      chunk.highlightEnd > chunk.highlightStart
        ? { start: chunk.highlightStart, end: chunk.highlightEnd }
        : null;

    setActiveChunkId(chunk.chunkId);
    setViewerConfig({
      identifier: chunk.stagePath,
      stageReference: chunk.stageReference,
      fileId: chunk.fileId,
      page: chunk.pageNumber,
      highlight,
    });
    setViewerStatus('loading');
    setViewerMessage('Loading PDF preview…');
  }, []);

  useEffect(() => {
    const identifier = viewerConfig?.identifier;
    if (!identifier) {
      setDocumentSource(null);
      setNumPages(null);
      textSegmentMapRef.current.clear();
      pageRefs.current.clear();
      setViewerStatus('idle');
      setViewerMessage('Select a chunk to preview the PDF.');
      return;
    }

    const controller = new AbortController();
    const fetchPdf = async () => {
      setDocumentSource(null);
      setNumPages(null);
      textSegmentMapRef.current.clear();
      pageRefs.current.clear();
      hasAutoScrolledRef.current = false;

      try {
        const params = new URLSearchParams();
        params.set('identifier', identifier);
        if (viewerConfig.stageReference) {
          params.set('stage', viewerConfig.stageReference);
        }
        if (viewerConfig.fileId) {
          params.set('fileId', viewerConfig.fileId);
        }
        const response = await fetch(`${apiBaseUrl}/api/pdf?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Unable to download the PDF (status ${response.status}).`);
        }
        const buffer = await response.arrayBuffer();
        setDocumentSource({ data: new Uint8Array(buffer) });
        setViewerMessage(null);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error('Failed to download PDF', error);
          setViewerStatus('idle');
          setViewerMessage(
            error instanceof Error ? error.message : 'Something went wrong while streaming the PDF.',
          );
        }
      }
    };

    fetchPdf();
    return () => controller.abort();
  }, [viewerConfig]);

  const handleDocumentLoadSuccess = useCallback<NonNullable<DocumentProps['onLoadSuccess']>>(
    (pdf) => {
      setNumPages(pdf.numPages);
      setViewerMessage(null);
    },
    [viewerConfig?.page],
  );

  const handleDocumentLoadError = useCallback<NonNullable<DocumentProps['onLoadError']>>((error) => {
    console.error('PDF load error', error);
    setViewerStatus('idle');
    setViewerMessage(
      error instanceof Error ? `Failed to decode PDF: ${error.message}` : 'Failed to decode PDF.',
    );
  }, []);

  const handleTextSuccess = useCallback(
    (pageNumber: number, textContent: TextContent) => {
      const nextMap = new Map<number, { start: number; end: number }>();
      let cursor = 0;

      textContent.items.forEach((item, index) => {
        if (!isTextItem(item)) {
          return;
        }
        const start = cursor;
        const end = start + item.str.length;
        nextMap.set(index, { start, end });
        cursor = end;
      });

      textSegmentMapRef.current.set(pageNumber, nextMap);
      setTextLayerVersion((version) => version + 1);

      if (viewerConfig && pageNumber === viewerConfig.page) {
        setViewerStatus('ready');
      }
    },
    [viewerConfig],
  );

  const customTextRenderer = useCallback(
    (
      pageNumber: number,
      { itemIndex, str }: Parameters<NonNullable<PageProps['customTextRenderer']>>[0],
    ) => {
      if (!viewerConfig || pageNumber !== viewerConfig.page) {
        return escapeHtml(str);
      }

      const highlight = viewerConfig.highlight;
      if (!highlight || highlight.end <= highlight.start) {
        return escapeHtml(str);
      }

      const pageSegments = textSegmentMapRef.current.get(pageNumber);
      if (!pageSegments) {
        return escapeHtml(str);
      }

      const bounds = pageSegments.get(itemIndex);
      if (!bounds) {
        return escapeHtml(str);
      }

      if (highlight.end <= bounds.start || highlight.start >= bounds.end) {
        return escapeHtml(str);
      }

      const relativeStart = Math.max(highlight.start - bounds.start, 0);
      const relativeEnd = Math.min(highlight.end - bounds.start, str.length);

      if (relativeStart >= relativeEnd) {
        return escapeHtml(str);
      }

      const before = str.slice(0, relativeStart);
      const highlighted = str.slice(relativeStart, relativeEnd);
      const after = str.slice(relativeEnd);

      return `${escapeHtml(before)}<mark class="highlighted-text">${escapeHtml(highlighted)}</mark>${escapeHtml(after)}`;
    },
    [viewerConfig, textLayerVersion],
  );

  useEffect(() => {
    if (!numPages || !viewerConfig || viewerStatus !== 'ready') {
      return;
    }
    const container = pagesContainerRef.current;
    const targetNode = pageRefs.current.get(viewerConfig.page);
    if (!container || !targetNode) {
      return;
    }
    const offset = targetNode.offsetTop - container.offsetTop - 16;
    container.scrollTo({
      top: Math.max(offset, 0),
      behavior: hasAutoScrolledRef.current ? 'smooth' : 'auto',
    });
    hasAutoScrolledRef.current = true;
  }, [numPages, viewerConfig, documentSource, viewerStatus]);

  const effectivePageWidth = useMemo(() => clamp(viewerWidth * zoomLevel, 280, 1800), [viewerWidth, zoomLevel]);
  const zoomPercent = Math.round(zoomLevel * 100);
  const disableZoomOut = zoomLevel <= MIN_ZOOM + 0.001;
  const disableZoomIn = zoomLevel >= MAX_ZOOM - 0.001;
  const disableQuestion = !question.trim() || selectedDocuments.length === 0 || queryLoading;
  const viewerOpen = Boolean(viewerConfig);
  const viewerReady = viewerStatus === 'ready';
  const viewerOverlayText =
    viewerStatus === 'loading' ? viewerMessage ?? 'Preparing PDF preview…' : viewerMessage;
  const workbenchClassName = `workbench${viewerOpen ? ' viewer-open' : ''}`;
  const viewerPanelClassName = `viewer-panel${viewerOpen ? ' open' : ''}`;
  const viewerOverlayTone = viewerStatus === 'idle' ? 'error' : 'info';

  const nudgeZoom = useCallback((direction: 'in' | 'out') => {
    setZoomLevel((current) => {
      const delta = direction === 'in' ? ZOOM_STEP : -ZOOM_STEP;
      return clamp(Number((current + delta).toFixed(2)), MIN_ZOOM, MAX_ZOOM);
    });
  }, []);

  const handleZoomSlider = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = Number(event.target.value);
    if (Number.isFinite(nextValue)) {
      setZoomLevel(clamp(nextValue, MIN_ZOOM, MAX_ZOOM));
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.body.classList.toggle('viewer-active', viewerOpen);
    return () => {
      document.body.classList.remove('viewer-active');
    };
  }, [viewerOpen]);

  useEffect(() => {
    if (!viewerOpen || typeof window === 'undefined') {
      return;
    }
    const stageNode = viewerStageRef.current;
    const ResizeObserverConstructor = window.ResizeObserver;
    if (!stageNode || typeof ResizeObserverConstructor !== 'function') {
      return;
    }
    const observer = new ResizeObserverConstructor((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const nextWidth = clamp(entry.contentRect.width - 32, 280, 1200);
      setViewerWidth((current) => Math.abs(current - nextWidth) > 1 ? nextWidth : current);
    });
    observer.observe(stageNode);
    return () => observer.disconnect();
  }, [viewerOpen]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const classList = document.body.classList;
    classList.remove('theme-light', 'theme-dark');
    classList.add(`theme-${theme}`);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  }, [theme]);

  return (
    <div className="app-shell">
      <header className="hero-header">
        <div>
          <h1>AI-PDF Chat v1</h1>
          <p className="subhead">
            Upload PDFs, choose which files to cite, then let the AI respond using the most relevant
            chunks. Tap a chunk to view the live PDF with highlights.
          </p>
        </div>
        <div className="hero-actions">
          <button
            className={`theme-toggle ${theme}`}
            type="button"
            onClick={toggleTheme}
            aria-label="Toggle color theme"
            aria-pressed={isDarkMode}
          >
            <span className="theme-toggle__icons" aria-hidden="true">
              <span className="theme-toggle__icon theme-toggle__icon--sun">☀︎</span>
              <span className="theme-toggle__icon theme-toggle__icon--moon">☾</span>
            </span>
            <span className="theme-toggle__track" aria-hidden="true">
              <span className="theme-toggle__thumb" />
            </span>
            <span className="theme-toggle__label">{isDarkMode ? 'Dark mode' : 'Light mode'}</span>
          </button>
          <button className="ghost-button" type="button" onClick={refreshDocuments} disabled={documentsLoading}>
            Refresh
          </button>
        </div>
      </header>

      <div className={workbenchClassName}>
        <section className="control-panel">
          <div className="panel-card upload-card">
            <div className="card-header">
              <div>
                <h2>Upload PDFs</h2>
                <p>Uploaded files are staged in Snowflake and vectorized automatically.</p>
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? 'Uploading…' : 'Add PDFs'}
              </button>
              <input
                type="file"
                ref={fileInputRef}
                className="sr-only"
                accept="application/pdf"
                multiple
                onChange={handleFileSelection}
              />
            </div>
            {uploadError && <p className="card-error">{uploadError}</p>}
            {/* <ul className="card-list">
              <li>Vector embedding model + chunk size defined in your environment.</li>
              <li>We store per-page character ranges to enable instant highlighting later.</li>
            </ul> */}
          </div>

          <div className="panel-card">
            <div className="card-header">
              <div>
                <h2>Pick Source PDFs</h2>
                <p>Select the files you want the AI to cite.</p>
              </div>
              <span className="pill">{selectedDocuments.length} selected</span>
            </div>
            {documentsError && <p className="card-error">{documentsError}</p>}
            {documentsLoading ? (
              <p className="card-note">Loading documents from Snowflake…</p>
            ) : documents.length === 0 ? (
              <p className="card-note">No documents yet. Start by uploading a PDF.</p>
            ) : (
              <div className="document-grid">
                {documents.map((doc) => {
                  const selected = selectedSet.has(doc.fileId);
                  return (
                    <button
                      key={doc.fileId}
                      type="button"
                      className={`document-chip ${selected ? 'selected' : ''}`}
                      onClick={() => toggleDocumentSelection(doc.fileId)}
                    >
                      <span className="document-name">{doc.filename}</span>
                      <span className="document-meta">
                        {doc.chunkCount} chunks · {formatTimestamp(doc.createdAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="panel-card question-card">
            <div className="card-header">
              <div>
                <h2>Ask a question</h2>
                <p>The AI only sees the PDFs you selected above.</p>
              </div>
            </div>
            <textarea
              rows={3}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Write your question here."
            />
            {queryError && <p className="card-error">{queryError}</p>}
            <div className="question-footer">
              <button
                className="primary-button"
                type="button"
                onClick={handleAskQuestion}
                disabled={disableQuestion}
              >
                {queryLoading ? 'Thinking…' : 'Ask AI'}
              </button>
              {answer && <span className="pill neutral">Answer ready</span>}
            </div>
            <div className="answer-card">
              {answer ? (
                <p>{answer}</p>
              ) : (
                <p className="card-note">
                  Responses reference only the selected PDFs. Add a question to get started.
                </p>
              )}
            </div>
          </div>

          <div className="panel-card sources-card">
            <div className="card-header">
              <div>
                <h2>Sources</h2>
                <p>Top chunks returned from Snowflake vector search.</p>
              </div>
            </div>
            {sources.length === 0 ? (
              <p className="card-note">Sources will appear here once you run a question.</p>
            ) : (
              <div className="source-list">
                {sources.map((chunk) => {
                  const highlightLabel =
                    Number.isFinite(chunk.highlightStart) && Number.isFinite(chunk.highlightEnd)
                      ? `${chunk.highlightStart} → ${chunk.highlightEnd}`
                      : '—';
                  return (
                    <button
                      key={chunk.chunkId}
                      type="button"
                      className={`source-chip ${chunk.chunkId === activeChunkId ? 'active' : ''}`}
                      onClick={() => handleChunkSelect(chunk)}
                    >
                      <div className="source-chip__meta">
                        <span>{chunk.fileName}</span>
                        <span>Page {chunk.pageNumber}</span>
                      </div>
                      <p>{chunk.text}</p>
                      <div className="source-chip__footer">
                        <span>Score {chunk.relevance.toFixed(2)}</span>
                        <span>Highlight {highlightLabel}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <aside className={viewerPanelClassName} aria-hidden={!viewerOpen}>
          {viewerConfig && (
            <>
              <div className="viewer-header">
                <div>
                  <p className="eyebrow">PDF Preview</p>
                  <h2>Context with highlights</h2>
                </div>
                <div className="viewer-toolbar">
                  <div className="zoom-controls" aria-label="Zoom controls">
                    <button
                      className="zoom-button"
                      type="button"
                      onClick={() => nudgeZoom('out')}
                      disabled={disableZoomOut}
                      aria-label="Zoom out"
                    >
                      −
                    </button>
                    <input
                      className="zoom-slider"
                      type="range"
                      min={MIN_ZOOM}
                      max={MAX_ZOOM}
                      step={0.05}
                      value={zoomLevel}
                      onChange={handleZoomSlider}
                      aria-label="Zoom level"
                    />
                    <span className="zoom-label" aria-live="polite">
                      {zoomPercent}%
                    </span>
                    <button
                      className="zoom-button"
                      type="button"
                      onClick={() => nudgeZoom('in')}
                      disabled={disableZoomIn}
                      aria-label="Zoom in"
                    >
                      +
                    </button>
                  </div>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => {
                      setViewerConfig(null);
                      setActiveChunkId(null);
                    }}
                  >
                    Hide
                  </button>
                </div>
              </div>
              <div className="viewer-shell">
                <div className="viewer-stage" ref={viewerStageRef}>
                  <div className={`pdf-viewer${viewerReady ? ' visible' : ''}`} aria-hidden={!viewerReady}>
                    {documentSource && (
                      <>
                        <Document
                          key={viewerConfig.identifier}
                          file={documentSource}
                          loading={<div className="status-card info">Preparing PDF…</div>}
                          error={
                            <div className="status-card error">
                              Unable to load PDF. Double-check the identifier and try again.
                            </div>
                          }
                          onLoadSuccess={handleDocumentLoadSuccess}
                          onLoadError={handleDocumentLoadError}
                        >
                          {numPages ? (
                            <div className="pdf-pages" ref={pagesContainerRef}>
                              {Array.from({ length: numPages }, (_, index) => {
                                const pageNumber = index + 1;
                                return (
                                  <div
                                    key={pageNumber}
                                    className="pdf-page-wrapper"
                                    ref={(node) => {
                                      if (node) {
                                        pageRefs.current.set(pageNumber, node);
                                      } else {
                                        pageRefs.current.delete(pageNumber);
                                      }
                                    }}
                                  >
                                    <Page
                                      className="pdf-page"
                                      pageNumber={pageNumber}
                                      width={effectivePageWidth}
                                      renderAnnotationLayer={false}
                                      renderTextLayer
                                      onGetTextSuccess={(textContent) => handleTextSuccess(pageNumber, textContent)}
                                      customTextRenderer={(item) => customTextRenderer(pageNumber, item)}
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="status-card info">Preparing PDF pages…</div>
                          )}
                        </Document>
                        {viewerReady && (
                          <div className="page-footnote">
                            Centered on page {viewerConfig.page} {numPages ? `of ${numPages}` : ''}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <div className={`viewer-overlay ${viewerReady ? 'hidden' : ''} ${viewerOverlayTone}`}>
                    {viewerStatus === 'loading' && (
                      <div className="loading-spinner" role="status" aria-label="Loading PDF preview" />
                    )}
                    {viewerOverlayText && <p>{viewerOverlayText}</p>}
                  </div>
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

export default App;
