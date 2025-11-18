import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
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

type SearchResult = { page: number; start: number; end: number };

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

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;

function App() {
  const queryConfig = useMemo(() => parseQueryParams(), []);
  const [documentSource, setDocumentSource] = useState<DocumentProps['file']>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [targetPage, setTargetPage] = useState<number>(queryConfig.page);
  const [viewerWidth, setViewerWidth] = useState(() =>
    clamp(window.innerWidth - 64, 320, 1200),
  );
  const [zoomFactor, setZoomFactor] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const textSegmentMapRef = useRef<Map<number, Map<number, { start: number; end: number }>>>(
    new Map(),
  );
  const pageTextMapRef = useRef<Map<number, string>>(new Map());
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
    let combinedText = '';

    textContent.items.forEach((item, index) => {
      if (!isTextItem(item)) {
        return;
      }
      const start = cursor;
      const end = start + item.str.length;
      nextMap.set(index, { start, end });
      cursor = end;
      combinedText += item.str;
    });

    textSegmentMapRef.current.set(pageNumber, nextMap);
    pageTextMapRef.current.set(pageNumber, combinedText);
    setTextLayerVersion((version) => version + 1);
  }, []);

  const highlightState = useMemo(() => {
    if (searchResults.length && searchResults[activeResultIndex]) {
      const current = searchResults[activeResultIndex];
      return {
        page: current.page,
        range: { start: current.start, end: current.end },
      };
    }

    if (
      queryConfig.highlight &&
      queryConfig.highlight.end > queryConfig.highlight.start &&
      Number.isFinite(queryConfig.highlight.start) &&
      Number.isFinite(queryConfig.highlight.end)
    ) {
      return {
        page: queryConfig.page,
        range: queryConfig.highlight,
      };
    }

    return null;
  }, [activeResultIndex, queryConfig.highlight, queryConfig.page, searchResults]);

  const customTextRenderer = useCallback(
    (pageNumber: number, { itemIndex, str }: Parameters<NonNullable<PageProps['customTextRenderer']>>[0]) => {
      if (!highlightState?.range || pageNumber !== highlightState.page) {
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

      const highlight = highlightState.range;
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
    [highlightState, textLayerVersion],
  );

  useEffect(() => {
    pageRefs.current.clear();
    textSegmentMapRef.current.clear();
    pageTextMapRef.current.clear();
    hasAutoScrolledRef.current = false;
    setSearchResults([]);
    setActiveResultIndex(0);
  }, [documentSource]);

  const clampPageNumber = useCallback(
    (value: number) => {
      if (!numPages || numPages < 1) {
        return Math.max(1, value);
      }
      return clamp(value, 1, numPages);
    },
    [numPages],
  );

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

  const handleZoomChange = useCallback((nextZoom: number) => {
    setZoomFactor((current) => clamp(nextZoom ?? current, ZOOM_MIN, ZOOM_MAX));
  }, []);

  const handleZoomStep = useCallback((delta: number) => {
    setZoomFactor((current) => clamp(Number((current + delta).toFixed(2)), ZOOM_MIN, ZOOM_MAX));
  }, []);

  const handlePageInput = useCallback(
    (value: string) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return;
      }
      const nextPage = clampPageNumber(Math.floor(parsed));
      setTargetPage(nextPage);
      requestAnimationFrame(() => scrollPageIntoView(nextPage, 'smooth'));
    },
    [clampPageNumber, scrollPageIntoView],
  );

  const handlePageStep = useCallback(
    (delta: number) => {
      setTargetPage((current) => {
        const nextPage = clampPageNumber((current ?? 1) + delta);
        requestAnimationFrame(() => scrollPageIntoView(nextPage, 'smooth'));
        return nextPage;
      });
    },
    [clampPageNumber, scrollPageIntoView],
  );

  const runSearch = useCallback(
    (query: string) => {
      const normalized = query.trim();
      if (!normalized) {
        setSearchResults([]);
        setActiveResultIndex(0);
        return;
      }

      const lowerQuery = normalized.toLowerCase();
      const nextResults: SearchResult[] = [];
      pageTextMapRef.current.forEach((text, pageNumber) => {
        if (!text) {
          return;
        }
        const lowerText = text.toLowerCase();
        let index = lowerText.indexOf(lowerQuery);
        while (index !== -1) {
          nextResults.push({
            page: pageNumber,
            start: index,
            end: index + normalized.length,
          });
          index = lowerText.indexOf(lowerQuery, index + lowerQuery.length);
        }
      });

      nextResults.sort((a, b) => (a.page === b.page ? a.start - b.start : a.page - b.page));
      setSearchResults(nextResults);
      setActiveResultIndex(0);

      if (nextResults.length > 0) {
        const first = nextResults[0];
        setTargetPage(first.page);
        requestAnimationFrame(() => scrollPageIntoView(first.page, 'smooth'));
      }
    },
    [scrollPageIntoView],
  );

  const handleSearchSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      runSearch(searchQuery);
    },
    [runSearch, searchQuery],
  );

  const handleSearchNavigate = useCallback(
    (direction: 1 | -1) => {
      if (!searchResults.length) {
        return;
      }
      setActiveResultIndex((current) => {
        const nextIndex = (current + direction + searchResults.length) % searchResults.length;
        const nextResult = searchResults[nextIndex];
        if (nextResult) {
          setTargetPage(nextResult.page);
          requestAnimationFrame(() => scrollPageIntoView(nextResult.page, 'smooth'));
        }
        return nextIndex;
      });
    },
    [scrollPageIntoView, searchResults],
  );

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults([]);
    setActiveResultIndex(0);
  }, []);

  const pageWidth = Math.round(viewerWidth * zoomFactor);
  const disablePrevPage = targetPage <= 1 || !numPages;
  const disableNextPage = !numPages || Boolean(numPages && targetPage >= numPages);
  const hasSearchResults = searchResults.length > 0;

  return (
    <div className="app-shell">
      <main className="app-main">
        <section className="viewer-toolbar">
          <div className="toolbar-group">
            <button
              type="button"
              className="toolbar-button"
              onClick={() => handlePageStep(-1)}
              disabled={disablePrevPage}
            >
              Prev
            </button>
            <label className="page-input-label">
              Page
              <input
                type="number"
                min={1}
                max={numPages ?? undefined}
                value={targetPage}
                onChange={(event) => handlePageInput(event.target.value)}
                className="page-input"
              />
              {numPages ? <span className="page-count">/ {numPages}</span> : null}
            </label>
            <button
              type="button"
              className="toolbar-button"
              onClick={() => handlePageStep(1)}
              disabled={disableNextPage}
            >
              Next
            </button>
          </div>

          <div className="toolbar-group zoom-controls">
            <button
              type="button"
              className="toolbar-button"
              onClick={() => handleZoomStep(-ZOOM_STEP)}
              disabled={zoomFactor <= ZOOM_MIN}
            >
              −
            </button>
            <input
              type="range"
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step={ZOOM_STEP}
              value={zoomFactor}
              onChange={(event) => handleZoomChange(Number(event.target.value))}
              className="zoom-slider"
            />
            <button
              type="button"
              className="toolbar-button"
              onClick={() => handleZoomStep(ZOOM_STEP)}
              disabled={zoomFactor >= ZOOM_MAX}
            >
              +
            </button>
            <span className="zoom-value">{Math.round(zoomFactor * 100)}%</span>
          </div>

          <form className="toolbar-group search-controls" onSubmit={handleSearchSubmit}>
            <input
              type="text"
              placeholder="Find text..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="search-input"
            />
            <button type="submit" className="toolbar-button">
              Search
            </button>
            <button
              type="button"
              className="toolbar-button"
              onClick={handleClearSearch}
              disabled={!searchQuery && !hasSearchResults}
            >
              Clear
            </button>
            <div className="search-navigation">
              <button
                type="button"
                className="toolbar-button"
                onClick={() => handleSearchNavigate(-1)}
                disabled={!hasSearchResults}
              >
                Prev Match
              </button>
              <button
                type="button"
                className="toolbar-button"
                onClick={() => handleSearchNavigate(1)}
                disabled={!hasSearchResults}
              >
                Next Match
              </button>
              <span className="search-status">
                {hasSearchResults ? `${activeResultIndex + 1} / ${searchResults.length}` : '0 / 0'}
              </span>
            </div>
          </form>
        </section>

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
                          width={pageWidth}
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
