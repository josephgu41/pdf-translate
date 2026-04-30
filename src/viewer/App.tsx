import {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  FormEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import PdfReader, { PageJumpRequest, PdfOutlineItem } from "./PdfReader";
import type { TranslateRequest, TranslateResponse } from "../types";

const SOURCE_LANGUAGE = "auto";
const TARGET_LANGUAGE = "zh-CN";
const TRANSLATE_DEBOUNCE_MS = 350;
const ZOOM_DEBOUNCE_MS = 200;
const MIN_SCALE = 0.7;
const MAX_SCALE = 5;
const SCALE_STEP = 0.1;
const MIN_READER_WIDTH = 320;
const MIN_TRANSLATION_WIDTH = 280;
const DIVIDER_WIDTH = 8;

type TranslationStatus = "idle" | "loading" | "success" | "error";

export default function App() {
  const [fileName, setFileName] = useState("");
  const [fileData, setFileData] = useState<Uint8Array | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [pageInput, setPageInput] = useState("");
  const [pageJumpRequest, setPageJumpRequest] =
    useState<PageJumpRequest | null>(null);
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [scale, setScale] = useState(1.2);
  const [previewScale, setPreviewScale] = useState(1.2);
  const [translationWidth, setTranslationWidth] = useState(380);
  const [isResizing, setIsResizing] = useState(false);
  const [isPdfDragActive, setIsPdfDragActive] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [translationStatus, setTranslationStatus] =
    useState<TranslationStatus>("idle");
  const [translationError, setTranslationError] = useState("");

  const shellRef = useRef<HTMLDivElement | null>(null);
  const dragDepthRef = useRef(0);
  const requestIdRef = useRef(0);
  const translationCacheRef = useRef(new Map<string, string>());
  const zoomTimerRef = useRef<number>(0);
  const pendingScaleRef = useRef(1.2);

  const openPdfFile = useCallback(async (file: File) => {
    if (!isPdfFile(file)) {
      return;
    }

    const arrayBuffer = await file.arrayBuffer();
    setFileName(file.name);
    setFileData(new Uint8Array(arrayBuffer));
    setPageCount(0);
    setCurrentPage(0);
    setPageInput("");
    setPageJumpRequest(null);
    setOutline([]);
    setSelectedText("");
    setTranslatedText("");
    setTranslationStatus("idle");
    setTranslationError("");
  }, []);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    await openPdfFile(file);
    event.target.value = "";
  };

  const handleSelectionChange = useCallback((text: string) => {
    const normalizedText = normalizeSelectedText(text);
    setSelectedText((current) =>
      current === normalizedText ? current : normalizedText
    );
  }, []);

  const handleZoomByDelta = useCallback((delta: number) => {
    const next = clamp(pendingScaleRef.current + delta, MIN_SCALE, MAX_SCALE);
    pendingScaleRef.current = next;
    setPreviewScale(next);
    window.clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = window.setTimeout(() => {
      setScale(pendingScaleRef.current);
    }, ZOOM_DEBOUNCE_MS);
  }, []);

  const handleDocumentLoad = useCallback((loadedPageCount: number) => {
    setPageCount(loadedPageCount);
    setCurrentPage(loadedPageCount > 0 ? 1 : 0);
    setPageInput(loadedPageCount > 0 ? "1" : "");
  }, []);

  const handleCurrentPageChange = useCallback((pageNumber: number) => {
    setCurrentPage(pageNumber);
    setPageInput(pageNumber > 0 ? String(pageNumber) : "");
  }, []);

  const requestPageJump = useCallback((pageNumber: number) => {
    if (pageCount === 0) {
      return;
    }

    const targetPage = clamp(Math.round(pageNumber), 1, pageCount);
    setPageInput(String(targetPage));
    setCurrentPage(targetPage);
    setPageJumpRequest((current) => ({
      pageNumber: targetPage,
      requestId: (current?.requestId ?? 0) + 1
    }));
  }, [pageCount]);

  const handlePageJumpSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (pageCount === 0) {
      return;
    }

    const pageNumber = Number(pageInput);

    if (Number.isFinite(pageNumber)) {
      requestPageJump(pageNumber);
    }
  };

  const handleResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
  };

  const handleResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const shellElement = shellRef.current;

    if (!isResizing || !shellElement) {
      return;
    }

    const shellRect = shellElement.getBoundingClientRect();
    const requestedWidth = shellRect.right - event.clientX - DIVIDER_WIDTH / 2;
    const maxTranslationWidth =
      shellRect.width - MIN_READER_WIDTH - DIVIDER_WIDTH;

    setTranslationWidth(
      clamp(requestedWidth, MIN_TRANSLATION_WIDTH, maxTranslationWidth)
    );
  };

  const handleResizePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setIsResizing(false);
  };

  const handlePdfDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!hasDraggedFile(event)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current += 1;
    setIsPdfDragActive(true);
  };

  const handlePdfDragOver = (event: DragEvent<HTMLElement>) => {
    if (!hasDraggedFile(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsPdfDragActive(true);
  };

  const handlePdfDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!hasDraggedFile(event)) {
      return;
    }

    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    setIsPdfDragActive(dragDepthRef.current > 0);
  };

  const handlePdfDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsPdfDragActive(false);
    const file = Array.from(event.dataTransfer.files).find(isPdfFile);

    if (file) {
      await openPdfFile(file);
    }
  };

  useEffect(() => {
    const text = selectedText.trim();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (!text) {
      setTranslatedText("");
      setTranslationError("");
      setTranslationStatus("idle");
      return;
    }

    const cacheKey = `${SOURCE_LANGUAGE}:${TARGET_LANGUAGE}:${text}`;
    const cachedText = translationCacheRef.current.get(cacheKey);

    if (cachedText) {
      setTranslatedText(cachedText);
      setTranslationError("");
      setTranslationStatus("success");
      return;
    }

    setTranslatedText("");
    setTranslationError("");
    setTranslationStatus("loading");

    const timeoutId = window.setTimeout(() => {
      requestTranslation(text).then((response) => {
        if (requestId !== requestIdRef.current) {
          return;
        }

        if (response.ok) {
          translationCacheRef.current.set(cacheKey, response.translatedText);
          setTranslatedText(response.translatedText);
          setTranslationError("");
          setTranslationStatus("success");
          return;
        }

        setTranslatedText("");
        setTranslationError(response.error);
        setTranslationStatus("error");
      });
    }, TRANSLATE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [selectedText]);

  const shellStyle = {
    "--translation-width": `${translationWidth}px`
  } as CSSProperties;

  return (
    <div
      ref={shellRef}
      className={`app-shell${isResizing ? " is-resizing" : ""}`}
      style={shellStyle}
    >
      <main
        className={`reader-pane${isPdfDragActive ? " is-drag-active" : ""}`}
        aria-label="PDF reading area"
        onDragEnter={handlePdfDragEnter}
        onDragOver={handlePdfDragOver}
        onDragLeave={handlePdfDragLeave}
        onDrop={handlePdfDrop}
      >
        <header className="toolbar">
          <div className="toolbar-group">
            <label className="file-button">
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={handleFileChange}
              />
              Open PDF
            </label>
            <span className="file-name" title={fileName}>
              {fileName || "No PDF selected"}
            </span>
          </div>

          <div className="toolbar-group">
            <form className="page-jump" onSubmit={handlePageJumpSubmit}>
              <input
                aria-label="Page number"
                className="page-input"
                inputMode="numeric"
                min="1"
                max={pageCount || undefined}
                type="number"
                value={pageInput}
                disabled={pageCount === 0}
                onChange={(event) => setPageInput(event.target.value)}
              />
              <span className="page-count">/ {pageCount || "-"}</span>
              <button
                type="submit"
                className="jump-button"
                disabled={pageCount === 0}
              >
                Go
              </button>
            </form>
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom out"
              onClick={() => handleZoomByDelta(-SCALE_STEP)}
            >
              -
            </button>
            <span className="zoom-label">{Math.round(previewScale * 100)}%</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom in"
              onClick={() => handleZoomByDelta(SCALE_STEP)}
            >
              +
            </button>
          </div>
        </header>

        <div className="reader-content">
          <nav className="outline-pane" aria-label="PDF outline">
            <div className="outline-title">Contents</div>
            {outline.length > 0 ? (
              <div className="outline-list">
                {outline.map((item) => renderOutlineItem(item, requestPageJump))}
              </div>
            ) : (
              <div className="outline-empty">
                {fileData ? "No contents in this PDF." : "Open a PDF to view contents."}
              </div>
            )}
          </nav>

          <PdfReader
            fileData={fileData}
            scale={scale}
            previewScale={previewScale}
            pageJumpRequest={pageJumpRequest}
            onZoomByDelta={handleZoomByDelta}
            onDocumentLoad={handleDocumentLoad}
            onCurrentPageChange={handleCurrentPageChange}
            onOutlineLoad={setOutline}
            onSelectionChange={handleSelectionChange}
          />
        </div>
        {isPdfDragActive && (
          <div className="drop-overlay" aria-hidden="true">
            Drop PDF to open
          </div>
        )}
      </main>

      <div
        className="pane-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize PDF and translation panes"
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
      />

      <aside className="translation-pane" aria-label="Translation area">
        <header className="translation-header">
          <div>
            <h1>PDF Translator</h1>
            <p>
              {pageCount > 0
                ? `Page ${currentPage || 1} of ${pageCount} · auto to Chinese`
                : "auto to Chinese"}
            </p>
          </div>
          <span className={`status-dot status-${translationStatus}`} />
        </header>

        <section className="text-panel source-panel" aria-label="Selected text">
          <div className="panel-title">Original</div>
          <div className="panel-body">
            {selectedText || (
              <span className="placeholder">Select text in the PDF.</span>
            )}
          </div>
        </section>

        <section className="text-panel target-panel" aria-label="Translated text">
          <div className="panel-title">Translation</div>
          <div className="panel-body">
            {translationStatus === "loading" && (
              <span className="placeholder">Translating...</span>
            )}
            {translationStatus === "error" && (
              <span className="error-text">{translationError}</span>
            )}
            {translationStatus === "success" && translatedText}
            {translationStatus === "idle" && (
              <span className="placeholder">Translation appears here.</span>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

function normalizeSelectedText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );
}

function hasDraggedFile(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function renderOutlineItem(
  item: PdfOutlineItem,
  onJump: (pageNumber: number) => void
) {
  return (
    <div className="outline-item" key={item.id}>
      <button
        type="button"
        className="outline-link"
        disabled={!item.pageNumber}
        onClick={() => item.pageNumber && onJump(item.pageNumber)}
        title={item.pageNumber ? `Page ${item.pageNumber}` : undefined}
      >
        <span>{item.title}</span>
        {item.pageNumber && <span className="outline-page">{item.pageNumber}</span>}
      </button>
      {item.items.length > 0 && (
        <div className="outline-children">
          {item.items.map((child) => renderOutlineItem(child, onJump))}
        </div>
      )}
    </div>
  );
}

function requestTranslation(text: string): Promise<TranslateResponse> {
  const request: TranslateRequest = {
    type: "TRANSLATE_TEXT",
    text,
    source: SOURCE_LANGUAGE,
    target: TARGET_LANGUAGE
  };

  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      resolve({
        ok: false,
        error: "Chrome extension runtime is unavailable. Load the built extension to translate."
      });
      return;
    }

    chrome.runtime.sendMessage(request, (response?: TranslateResponse) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError) {
        resolve({
          ok: false,
          error: runtimeError.message || "Chrome runtime request failed."
        });
        return;
      }

      if (!response) {
        resolve({ ok: false, error: "No response from the translator." });
        return;
      }

      resolve(response);
    });
  });
}
