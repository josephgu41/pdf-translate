import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import PdfReader from "./PdfReader";
import type { TranslateRequest, TranslateResponse } from "../types";

const SOURCE_LANGUAGE = "auto";
const TARGET_LANGUAGE = "zh-CN";
const TRANSLATE_DEBOUNCE_MS = 350;

type TranslationStatus = "idle" | "loading" | "success" | "error";

export default function App() {
  const [fileName, setFileName] = useState("");
  const [fileData, setFileData] = useState<Uint8Array | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [selectedText, setSelectedText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [translationStatus, setTranslationStatus] =
    useState<TranslationStatus>("idle");
  const [translationError, setTranslationError] = useState("");

  const requestIdRef = useRef(0);
  const translationCacheRef = useRef(new Map<string, string>());

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const arrayBuffer = await file.arrayBuffer();
    setFileName(file.name);
    setFileData(new Uint8Array(arrayBuffer));
    setPageCount(0);
    setSelectedText("");
    setTranslatedText("");
    setTranslationStatus("idle");
    setTranslationError("");
  };

  const handleSelectionChange = useCallback((text: string) => {
    const normalizedText = normalizeSelectedText(text);
    setSelectedText((current) =>
      current === normalizedText ? current : normalizedText
    );
  }, []);

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

  return (
    <div className="app-shell">
      <main className="reader-pane" aria-label="PDF reading area">
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
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom out"
              onClick={() => setScale((current) => Math.max(0.7, current - 0.1))}
            >
              -
            </button>
            <span className="zoom-label">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom in"
              onClick={() => setScale((current) => Math.min(2.2, current + 0.1))}
            >
              +
            </button>
          </div>
        </header>

        <PdfReader
          fileData={fileData}
          scale={scale}
          onDocumentLoad={setPageCount}
          onSelectionChange={handleSelectionChange}
        />
      </main>

      <aside className="translation-pane" aria-label="Translation area">
        <header className="translation-header">
          <div>
            <h1>PDF Translator</h1>
            <p>
              {pageCount > 0
                ? `${pageCount} pages · auto to Chinese`
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
