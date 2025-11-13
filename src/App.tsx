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

type QueryConfig = {
  identifier: string | null;
  page: number;
  highlight: HighlightRange | null;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const pickFirstParam = (params: URLSearchParams, candidates: string[]) => {
  for (const key of candidates) {
    const value = params.get(key);
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
};

const pickNumericParam = (params: URLSearchParams, candidates: string[]) => {
  const rawValue = pickFirstParam(params, candidates);
  if (!rawValue) {
    return null;
  }

  const numValue = Number(rawValue);
  return Number.isFinite(numValue) ? numValue : null;
};

const parseQueryParams = (): QueryConfig => {
  const params = new URLSearchParams(window.location.search);
  const identifier = pickFirstParam(params, ['pdf', 'identifier', 'file']);
  const requestedPage = pickNumericParam(params, ['page', 'pageNumber']) ?? 1;
  const startIndex = pickNumericParam(params, ['highlightStart', 'highlight_start', 'start']);
  const endIndex = pickNumericParam(params, ['highlightEnd', 'highlight_end', 'end']);

  const sanitizedPage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const highlightRange =
    Number.isFinite(startIndex) &&
    Number.isFinite(endIndex) &&
    typeof startIndex === 'number' &&
    typeof endIndex === 'number' &&
    endIndex > startIndex &&
    startIndex >= 0
      ? { start: Math.floor(startIndex), end: Math.floor(endIndex) }
      : null;

  return {
    identifier,
    page: sanitizedPage,
    highlight: highlightRange,
  };
};

const isTextItem = (item: TextContent['items'][number]): item is TextItem =>
  Boolean(item && typeof item === 'object' && 'str' in item);

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

function App() {
  const queryConfig = useMemo(() => parseQueryParams(), []);
  const [documentSource, setDocumentSource] = useState<DocumentProps['file']>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [targetPage, setTargetPage] = useState<number>(queryConfig.page);
  const [viewerWidth, setViewerWidth] = useState(() =>
    clamp(window.innerWidth - 64, 320, 1200),
  );
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const textSegmentMapRef = useRef<Map<number, Map<number, { start: number; end: number }>>>(
    new Map(),
  );
  const pageRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const pagesContainerRef = useRef<HTMLDivElement | null>(null);
  const hasAutoScrolledRef = useRef(false);
  const [textLayerVersion, setTextLayerVersion] = useState(0);

  useEffect(() => {
    const handleResize = () => {
      setViewerWidth(clamp(window.innerWidth - 64, 320, 1200));
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const identifier = queryConfig.identifier;
    if (!identifier) {
      setErrorMessage('Missing ?pdf=<identifier> query parameter.');
      setDocumentSource(null);
      return;
    }

    const controller = new AbortController();
    const fetchPdf = async () => {
      setIsLoading(true);
      setErrorMessage(null);

      try {
        const response = await fetch(`${apiBaseUrl}/api/pdf?identifier=${encodeURIComponent(identifier)}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const buffer = await response.arrayBuffer();
        setDocumentSource({ data: new Uint8Array(buffer) });
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error('Failed to download PDF', error);
          setErrorMessage(
            error instanceof Error ? error.message : 'Something went wrong while fetching the PDF.',
          );
          setDocumentSource(null);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    fetchPdf();

    return () => {
      controller.abort();
    };
  }, [queryConfig.identifier]);

  const handleDocumentLoadSuccess = useCallback<NonNullable<DocumentProps['onLoadSuccess']>>(
    (pdf) => {
      setNumPages(pdf.numPages);
      setTargetPage((current) => clamp(current || queryConfig.page, 1, pdf.numPages));
      setErrorMessage(null);
    },
    [queryConfig.page],
  );

  const handleDocumentLoadError = useCallback<NonNullable<DocumentProps['onLoadError']>>((error) => {
    console.error('PDF load error', error);
    setErrorMessage(
      error instanceof Error ? `Failed to decode PDF: ${error.message}` : 'Failed to decode PDF.',
    );
  }, []);

  const handleTextSuccess = useCallback((pageNumber: number, textContent: TextContent) => {
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
  }, []);

  const customTextRenderer = useCallback(
    (pageNumber: number, { itemIndex, str }: Parameters<NonNullable<PageProps['customTextRenderer']>>[0]) => {
      if (pageNumber !== targetPage) {
        return escapeHtml(str);
      }

      const highlight = queryConfig.highlight;
      if (!highlight) {
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
    [queryConfig.highlight, targetPage, textLayerVersion],
  );

  const highlightSummary =
    queryConfig.highlight && queryConfig.highlight.end > queryConfig.highlight.start
      ? `${queryConfig.highlight.start} → ${queryConfig.highlight.end}`
      : '—';

  useEffect(() => {
    pageRefs.current.clear();
    textSegmentMapRef.current.clear();
    hasAutoScrolledRef.current = false;
  }, [documentSource]);

  const scrollPageIntoView = useCallback(
    (pageNumber = targetPage, behavior?: ScrollBehavior) => {
      const container = pagesContainerRef.current;
      const targetNode = pageRefs.current.get(pageNumber);
      if (!container || !targetNode) {
        return;
      }
      const offset = targetNode.offsetTop - container.offsetTop - 16;
      container.scrollTo({
        top: Math.max(offset, 0),
        behavior: behavior ?? (hasAutoScrolledRef.current ? 'smooth' : 'auto'),
      });
      hasAutoScrolledRef.current = true;
    },
    [targetPage],
  );

  useEffect(() => {
    if (!numPages) {
      return;
    }
    scrollPageIntoView(targetPage);
  }, [numPages, targetPage, documentSource, scrollPageIntoView]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          {/* <p className="eyebrow">Snowflake PDF Stage Viewer</p> */}
          <h1>Snowflake PDF Stage Viewer</h1>
          {/* <p className="subhead">
            Pass <code>?pdf=</code>, <code>&page=</code>, and <code>&highlightStart=</code> /
            <code>&highlightEnd=</code> to deep link directly to the text
          </p> */}
        </div>
        <dl className="query-summary">
          <div>
            <dt>PDF Identifier</dt>
            <dd>{queryConfig.identifier ?? 'Not provided'}</dd>
          </div>
          <div>
            <dt>Requested Page</dt>
            <dd>{queryConfig.page}</dd>
          </div>
          <div>
            <dt>Highlight Range</dt>
            <dd>{highlightSummary}</dd>
          </div>
        </dl>
      </header>

      <main className="app-main">
        {errorMessage && <div className="status-card error">{errorMessage}</div>}
        {isLoading && <div className="status-card info">Fetching PDF from Snowflake…</div>}
        {!queryConfig.identifier && (
          <div className="status-card warning">
            Provide a <code>?pdf=</code> identifier to begin streaming your document.
          </div>
        )}

        {documentSource && (
          <div className="pdf-viewer">
            <Document
              key={queryConfig.identifier ?? 'document'}
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
                            if (pageNumber === targetPage) {
                              requestAnimationFrame(() => scrollPageIntoView(pageNumber, 'auto'));
                            }
                          } else {
                            pageRefs.current.delete(pageNumber);
                          }
                        }}
                      >
                        <Page
                          className="pdf-page"
                          pageNumber={pageNumber}
                          width={viewerWidth}
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
            <div className="page-footnote">
              Centered on page {targetPage} {numPages ? `of ${numPages}` : ''}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
