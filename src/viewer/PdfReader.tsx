import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist/build/pdf";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
import "pdfjs-dist/web/pdf_viewer.css";

type PdfReaderProps = {
  fileData: Uint8Array | null;
  scale: number;
  onDocumentLoad: (pageCount: number) => void;
  onSelectionChange: (text: string) => void;
};

type RenderState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; error: string };

(pdfjsLib.GlobalWorkerOptions as { workerSrc: string }).workerSrc = workerUrl;

export default function PdfReader({
  fileData,
  scale,
  onDocumentLoad,
  onSelectionChange
}: PdfReaderProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const [renderState, setRenderState] = useState<RenderState>({ status: "idle" });

  useEffect(() => {
    const pagesElement = pagesRef.current;

    if (!pagesElement) {
      return;
    }

    pagesElement.innerHTML = "";

    if (!fileData) {
      setRenderState({ status: "idle" });
      onDocumentLoad(0);
      return;
    }

    const pdfData = fileData;
    const pageContainer = pagesElement;
    let cancelled = false;
    let loadingTask: {
      promise: Promise<{
        numPages: number;
        getPage: (pageNumber: number) => Promise<any>;
      }>;
      destroy: () => Promise<void>;
    } | null = null;
    const renderTasks: Array<{ cancel: () => void }> = [];

    async function renderPdf() {
      setRenderState({ status: "loading" });

      loadingTask = pdfjsLib.getDocument({ data: pdfData.slice() });
      const pdfDocument = await loadingTask.promise;

      if (cancelled) {
        return;
      }

      onDocumentLoad(pdfDocument.numPages);
      pageContainer.innerHTML = "";

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        if (cancelled) {
          return;
        }

        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        const pageElement = document.createElement("section");
        const canvas = document.createElement("canvas");
        const textLayerElement = document.createElement("div");
        const canvasContext = canvas.getContext("2d", { alpha: false });

        if (!canvasContext) {
          throw new Error("Canvas rendering is not available in this browser.");
        }

        pageElement.className = "page pdf-page";
        pageElement.setAttribute("data-page-number", String(pageNumber));
        pageElement.style.width = `${viewport.width}px`;
        pageElement.style.height = `${viewport.height}px`;

        canvas.className = "pdf-canvas";
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);

        textLayerElement.className = "textLayer";
        textLayerElement.style.width = `${viewport.width}px`;
        textLayerElement.style.height = `${viewport.height}px`;

        pageElement.append(canvas, textLayerElement);
        pageContainer.append(pageElement);

        const renderTask = page.render({
          canvasContext,
          viewport,
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0]
        });
        renderTasks.push(renderTask);
        await renderTask.promise;

        const textContent = await page.getTextContent();
        const textLayerTask = pdfjsLib.renderTextLayer({
          container: textLayerElement,
          textContentSource: textContent,
          textDivs: [],
          viewport: viewport.clone({ dontFlip: true })
        });

        await textLayerTask.promise;
      }

      if (!cancelled) {
        setRenderState({ status: "ready" });
      }
    }

    renderPdf().catch((error: unknown) => {
      if (cancelled) {
        return;
      }

      setRenderState({
        status: "error",
        error: error instanceof Error ? error.message : "PDF rendering failed."
      });
    });

    return () => {
      cancelled = true;
      renderTasks.forEach((task) => task.cancel());
      void loadingTask?.destroy();
    };
  }, [fileData, onDocumentLoad, scale]);

  const handleSelection = () => {
    const scrollElement = scrollRef.current;
    const selection = window.getSelection();

    if (!scrollElement || !selection || selection.isCollapsed) {
      onSelectionChange("");
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;

    if (
      !anchorNode ||
      !focusNode ||
      !scrollElement.contains(anchorNode) ||
      !scrollElement.contains(focusNode)
    ) {
      return;
    }

    onSelectionChange(selection.toString());
  };

  return (
    <div
      ref={scrollRef}
      className="pdf-scroll"
      tabIndex={0}
      onMouseUp={handleSelection}
      onKeyUp={handleSelection}
    >
      <div ref={pagesRef} className="pdf-pages" />

      {renderState.status === "idle" && (
        <div className="reader-empty">Choose a PDF to begin.</div>
      )}
      {renderState.status === "loading" && (
        <div className="reader-status">Rendering PDF...</div>
      )}
      {renderState.status === "error" && (
        <div className="reader-error">{renderState.error}</div>
      )}
    </div>
  );
}
