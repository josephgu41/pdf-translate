import { KeyboardEvent, PointerEvent, useEffect, useRef, useState } from "react";
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

type PointerPoint = {
  x: number;
  y: number;
};

type SelectedLine = {
  centerY: number;
  elements: TextRect[];
  page: HTMLElement;
};

type GeometrySelection = {
  text: string;
  highlights: HighlightRect[];
};

type HighlightRect = {
  page: HTMLElement;
  left: number;
  top: number;
  width: number;
  height: number;
};

type TextRect = {
  element: HTMLElement;
  page: HTMLElement;
  rect: DOMRect;
  centerY: number;
};

(pdfjsLib.GlobalWorkerOptions as { workerSrc: string }).workerSrc = workerUrl;

export default function PdfReader({
  fileData,
  scale,
  onDocumentLoad,
  onSelectionChange
}: PdfReaderProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const selectionStartRef = useRef<PointerPoint | null>(null);
  const isDraggingSelectionRef = useRef(false);
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

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    window.getSelection()?.removeAllRanges();
    selectionStartRef.current = { x: event.clientX, y: event.clientY };
    isDraggingSelectionRef.current = true;
    clearGeometryHighlight(scrollRef.current);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const scrollElement = scrollRef.current;

    if (!scrollElement || !isDraggingSelectionRef.current || !selectionStartRef.current) {
      return;
    }

    event.preventDefault();
    const pointerSelection = getGeometrySelection(
      scrollElement,
      selectionStartRef.current,
      { x: event.clientX, y: event.clientY }
    );

    if (pointerSelection?.text) {
      applyGeometryHighlight(scrollElement, pointerSelection.highlights);
      onSelectionChange(pointerSelection.text);
      return;
    }

    clearGeometryHighlight(scrollElement);
    onSelectionChange("");
  };

  const handleSelection = (event?: PointerEvent<HTMLDivElement>) => {
    const scrollElement = scrollRef.current;

    if (
      scrollElement &&
      event &&
      isDraggingSelectionRef.current &&
      selectionStartRef.current
    ) {
      event.preventDefault();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const pointerSelection = getGeometrySelection(
        scrollElement,
        selectionStartRef.current,
        { x: event.clientX, y: event.clientY }
      );

      isDraggingSelectionRef.current = false;
      selectionStartRef.current = null;
      window.getSelection()?.removeAllRanges();

      if (pointerSelection?.text) {
        applyGeometryHighlight(scrollElement, pointerSelection.highlights);
        onSelectionChange(pointerSelection.text);
        return;
      }

      clearGeometryHighlight(scrollElement);
      onSelectionChange("");
      return;
    }

    const selection = window.getSelection();

    if (!scrollElement || !selection || selection.isCollapsed) {
      clearGeometryHighlight(scrollElement);
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

    clearGeometryHighlight(scrollElement);
    onSelectionChange(selection.toString());
  };

  const handlePointerCancel = () => {
    isDraggingSelectionRef.current = false;
    selectionStartRef.current = null;
    clearGeometryHighlight(scrollRef.current);
    onSelectionChange("");
  };

  const handleKeyboardSelection = (_event: KeyboardEvent<HTMLDivElement>) => {
    handleSelection();
  };

  return (
    <div
      ref={scrollRef}
      className="pdf-scroll"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handleSelection}
      onPointerCancel={handlePointerCancel}
      onKeyUp={handleKeyboardSelection}
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

function getGeometrySelection(
  scrollElement: HTMLElement,
  start: PointerPoint,
  end: PointerPoint
): GeometrySelection | null {
  if (Math.hypot(end.x - start.x, end.y - start.y) < 3) {
    return null;
  }

  const textElements = Array.from(
    scrollElement.querySelectorAll<HTMLElement>(
      ".textLayer span:not(.markedContent)"
    )
  ).filter((element) => element.textContent?.trim());

  if (textElements.length === 0) {
    return null;
  }

  const textRects = textElements
    .flatMap((element) => {
      const page = element.closest<HTMLElement>(".pdf-page");

      if (!page) {
        return [];
      }

      const rect = element.getBoundingClientRect();

      return [{
        element,
        page,
        rect,
        centerY: rect.top + rect.height / 2
      }];
    })
    .filter(({ rect }) => rect.width > 0 && rect.height > 0)
    .sort((a, b) => a.centerY - b.centerY || a.rect.left - b.rect.left);

  const medianHeight = getMedian(textRects.map(({ rect }) => rect.height)) || 12;
  const lines = groupTextRectsByLine(textRects, medianHeight);
  const startLine = getClosestLineIndex(lines, start.y);
  const endLine = getClosestLineIndex(lines, end.y);

  if (startLine === -1 || endLine === -1) {
    return null;
  }

  const firstLine = Math.min(startLine, endLine);
  const lastLine = Math.max(startLine, endLine);
  const isForwardSelection =
    startLine < endLine || (startLine === endLine && start.x <= end.x);
  const selected: TextRect[] = [];

  for (let index = firstLine; index <= lastLine; index += 1) {
    const line = lines[index];
    let minX = Number.NEGATIVE_INFINITY;
    let maxX = Number.POSITIVE_INFINITY;

    if (startLine === endLine) {
      minX = Math.min(start.x, end.x);
      maxX = Math.max(start.x, end.x);
    } else if (isForwardSelection) {
      if (index === startLine) {
        minX = start.x;
      }

      if (index === endLine) {
        maxX = end.x;
      }
    } else {
      if (index === startLine) {
        maxX = start.x;
      }

      if (index === endLine) {
        minX = end.x;
      }
    }

    selected.push(
      ...line.elements.filter(
        ({ rect }) => rect.right >= minX && rect.left <= maxX
      )
    );
  }

  if (selected.length === 0) {
    return null;
  }

  const selectedElements = new Set(selected.map(({ element }) => element));
  const text = lines
    .map((line) =>
      line.elements
        .filter(({ element }) => selectedElements.has(element))
        .map(({ element }) => element.textContent?.trim())
        .filter(Boolean)
        .join(" ")
    )
    .filter(Boolean)
    .join("\n")
    .trim();

  return {
    text,
    highlights: getHighlightRects(selected)
  };
}

function groupTextRectsByLine(
  textRects: TextRect[],
  medianHeight: number
): SelectedLine[] {
  const lineTolerance = Math.max(3, medianHeight * 0.55);
  const lines: SelectedLine[] = [];

  for (const textRect of textRects) {
    const existingLine = lines.find(
      (line) =>
        line.page === textRect.page &&
        Math.abs(line.centerY - textRect.centerY) <= lineTolerance
    );

    if (existingLine) {
      existingLine.elements.push(textRect);
      existingLine.centerY =
        existingLine.elements.reduce((sum, item) => sum + item.centerY, 0) /
        existingLine.elements.length;
      continue;
    }

    lines.push({
      centerY: textRect.centerY,
      elements: [textRect],
      page: textRect.page
    });
  }

  return lines
    .map((line) => ({
      ...line,
      elements: line.elements.sort((a, b) => a.rect.left - b.rect.left)
    }))
    .sort((a, b) => a.centerY - b.centerY);
}

function getClosestLineIndex(lines: SelectedLine[], y: number): number {
  if (lines.length === 0) {
    return -1;
  }

  let closestIndex = 0;
  let closestDistance = Math.abs(lines[0].centerY - y);

  for (let index = 1; index < lines.length; index += 1) {
    const distance = Math.abs(lines[index].centerY - y);

    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  }

  return closestIndex;
}

function getHighlightRects(textRects: TextRect[]): HighlightRect[] {
  return textRects.map(({ page, rect }) => {
    const pageRect = page.getBoundingClientRect();

    return {
      page,
      left: rect.left - pageRect.left - 1,
      top: rect.top - pageRect.top - 1,
      width: rect.width + 2,
      height: rect.height + 2
    };
  });
}

function getMedian(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
}

function applyGeometryHighlight(
  scrollElement: HTMLElement,
  highlights: HighlightRect[]
) {
  clearGeometryHighlight(scrollElement);
  highlights.forEach((highlight) => {
    const element = document.createElement("div");
    element.className = "pdf-geometry-highlight";
    element.style.left = `${highlight.left}px`;
    element.style.top = `${highlight.top}px`;
    element.style.width = `${highlight.width}px`;
    element.style.height = `${highlight.height}px`;
    highlight.page.append(element);
  });
}

function clearGeometryHighlight(scrollElement: HTMLElement | null) {
  scrollElement
    ?.querySelectorAll(".pdf-geometry-highlight")
    .forEach((element) => element.remove());
}
