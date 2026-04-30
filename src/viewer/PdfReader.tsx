import {
  KeyboardEvent,
  PointerEvent,
  WheelEvent,
  useEffect,
  useRef,
  useState
} from "react";
import * as pdfjsLib from "pdfjs-dist/build/pdf";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
import "pdfjs-dist/web/pdf_viewer.css";

type PdfReaderProps = {
  fileData: Uint8Array | null;
  scale: number;
  previewScale: number;
  pageJumpRequest: PageJumpRequest | null;
  onZoomByDelta: (delta: number) => void;
  onDocumentLoad: (pageCount: number) => void;
  onCurrentPageChange: (pageNumber: number) => void;
  onOutlineLoad: (outline: PdfOutlineItem[]) => void;
  onSelectionChange: (text: string) => void;
};

export type PageJumpRequest = {
  pageNumber: number;
  requestId: number;
};

export type PdfOutlineItem = {
  id: string;
  title: string;
  pageNumber: number | null;
  items: PdfOutlineItem[];
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

type ScrollAnchor = {
  pageNumber: number;
  offsetRatio: number;
  leftRatio: number;
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

type PdfOutlineSourceItem = {
  title?: string;
  dest?: string | unknown[] | null;
  items?: PdfOutlineSourceItem[];
};

type PdfDocumentProxy = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<any>;
  getOutline: () => Promise<PdfOutlineSourceItem[] | null>;
  getDestination: (id: string) => Promise<unknown[] | null>;
  getPageIndex: (ref: unknown) => Promise<number>;
};

type PdfLoadingTask = {
  promise: Promise<PdfDocumentProxy>;
  destroy: () => Promise<void>;
};

(pdfjsLib.GlobalWorkerOptions as { workerSrc: string }).workerSrc = workerUrl;

export default function PdfReader({
  fileData,
  scale,
  previewScale,
  pageJumpRequest,
  onZoomByDelta,
  onDocumentLoad,
  onCurrentPageChange,
  onOutlineLoad,
  onSelectionChange
}: PdfReaderProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const previousFileDataRef = useRef<Uint8Array | null>(null);
  const selectionStartRef = useRef<PointerPoint | null>(null);
  const isDraggingSelectionRef = useRef(false);
  const [renderState, setRenderState] = useState<RenderState>({ status: "idle" });

  useEffect(() => {
    const pagesElement = pagesRef.current;

    if (!pagesElement) {
      return;
    }

    if (!fileData) {
      pagesElement.innerHTML = "";
      previousFileDataRef.current = null;
      setRenderState({ status: "idle" });
      onDocumentLoad(0);
      onCurrentPageChange(0);
      onOutlineLoad([]);
      return;
    }

    const pdfData = fileData;
    const pageContainer = pagesElement;
    const isSameDocument = previousFileDataRef.current === fileData;
    const scrollAnchor = isSameDocument
      ? getScrollAnchor(scrollRef.current)
      : null;
    const hasRenderedPages = isSameDocument && pageContainer.childElementCount > 0;
    let cancelled = false;
    let loadingTask: PdfLoadingTask | null = null;
    const renderTasks: Array<{ cancel: () => void }> = [];

    previousFileDataRef.current = fileData;

    if (!isSameDocument) {
      pageContainer.innerHTML = "";
    }

    async function renderPdf() {
      if (!hasRenderedPages) {
        setRenderState({ status: "loading" });
      }

      const task = pdfjsLib.getDocument({ data: pdfData.slice() }) as PdfLoadingTask;
      loadingTask = task;
      const pdfDocument = await task.promise;

      if (cancelled) {
        return;
      }

      if (!isSameDocument) {
        onDocumentLoad(pdfDocument.numPages);
        onCurrentPageChange(1);
        resolveOutline(pdfDocument).then((outline) => {
          if (!cancelled) {
            onOutlineLoad(outline);
          }
        });
      }

      const nextPages = document.createDocumentFragment();

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
        nextPages.append(pageElement);

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
        pageContainer.replaceChildren(nextPages);
        restoreScrollAnchor(scrollRef.current, scrollAnchor);
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
  }, [fileData, onCurrentPageChange, onDocumentLoad, onOutlineLoad, scale]);

  useEffect(() => {
    if (!pageJumpRequest) {
      return;
    }

    scrollToPage(scrollRef.current, pageJumpRequest.pageNumber);
  }, [pageJumpRequest]);

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
      return;
    }

    const selection = window.getSelection();

    if (!scrollElement || !selection || selection.isCollapsed) {
      clearGeometryHighlight(scrollElement);
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
  };

  const handleKeyboardSelection = (_event: KeyboardEvent<HTMLDivElement>) => {
    handleSelection();
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    event.preventDefault();
    onZoomByDelta(event.deltaY < 0 ? 0.1 : -0.1);
  };

  const handleScroll = () => {
    const pageNumber = getMostVisiblePageNumber(scrollRef.current);

    if (pageNumber > 0) {
      onCurrentPageChange(pageNumber);
    }
  };

  const zoomRatio = previewScale !== scale ? previewScale / scale : 1;
  const pagesStyle = zoomRatio !== 1
    ? { transform: `scale(${zoomRatio})`, transformOrigin: "center top" }
    : undefined;

  return (
    <div
      ref={scrollRef}
      className="pdf-scroll"
      tabIndex={0}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handleSelection}
      onPointerCancel={handlePointerCancel}
      onKeyUp={handleKeyboardSelection}
    >
      <div ref={pagesRef} className="pdf-pages" style={pagesStyle} />

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

  // Determine the X boundary for partial line selection
  let selStartX: number;
  let selEndX: number;

  if (startLine === endLine) {
    selStartX = Math.min(start.x, end.x);
    selEndX = Math.max(start.x, end.x);
  } else if (isForwardSelection) {
    selStartX = start.x;
    selEndX = end.x;
  } else {
    selStartX = end.x;
    selEndX = start.x;
  }

  const highlights: HighlightRect[] = [];
  const textParts: string[] = [];

  for (let index = firstLine; index <= lastLine; index += 1) {
    const line = lines[index];
    const isFirst = index === firstLine;
    const isLast = index === lastLine;
    const isSingleLine = firstLine === lastLine;

    if (!isFirst && !isLast) {
      // Middle line: select everything, merge into one highlight rect per line
      const lineText = line.elements
        .map(({ element }) => element.textContent?.trim())
        .filter(Boolean)
        .join(" ");

      if (lineText) {
        textParts.push(lineText);
      }

      // Merge all element rects into one line-spanning highlight
      const lineHighlight = mergeLineHighlight(line.elements);

      if (lineHighlight) {
        highlights.push(lineHighlight);
      }

      continue;
    }

    // First line, last line, or single line: use character-level precision
    const lineMinX = isFirst || isSingleLine ? selStartX : Number.NEGATIVE_INFINITY;
    const lineMaxX = isLast || isSingleLine ? selEndX : Number.POSITIVE_INFINITY;

    const lineTextParts: string[] = [];

    for (const textRect of line.elements) {
      const { element, page, rect } = textRect;

      // Skip elements entirely outside the X range
      if (rect.right < lineMinX || rect.left > lineMaxX) {
        continue;
      }

      // Element fully within range: use full rect
      if (rect.left >= lineMinX && rect.right <= lineMaxX) {
        lineTextParts.push(element.textContent?.trim() || "");
        const pageRect = page.getBoundingClientRect();
        highlights.push({
          page,
          left: rect.left - pageRect.left - 1,
          top: rect.top - pageRect.top - 1,
          width: rect.width + 2,
          height: rect.height + 2
        });
        continue;
      }

      // Partial selection: use Range + getClientRects for character-level precision
      const charRects = getCharacterRects(element);

      if (charRects.length === 0) {
        continue;
      }

      // Find the first and last character indices within the X range
      let charStart = 0;
      let charEnd = charRects.length - 1;

      for (let ci = 0; ci < charRects.length; ci += 1) {
        if (charRects[ci].right >= lineMinX) {
          charStart = ci;
          break;
        }
      }

      for (let ci = charRects.length - 1; ci >= 0; ci -= 1) {
        if (charRects[ci].left <= lineMaxX) {
          charEnd = ci;
          break;
        }
      }

      if (charStart > charEnd) {
        continue;
      }

      // Extract the text substring
      const fullText = element.textContent || "";
      lineTextParts.push(fullText.slice(charStart, charEnd + 1).trim());

      // Create highlight from the precise character range
      const pageRect = page.getBoundingClientRect();
      const firstCharRect = charRects[charStart];
      const lastCharRect = charRects[charEnd];
      const highlightLeft = firstCharRect.left;
      const highlightRight = lastCharRect.right;
      const highlightTop = Math.min(firstCharRect.top, lastCharRect.top);
      const highlightBottom = Math.max(firstCharRect.bottom, lastCharRect.bottom);

      highlights.push({
        page,
        left: highlightLeft - pageRect.left - 1,
        top: highlightTop - pageRect.top - 1,
        width: highlightRight - highlightLeft + 2,
        height: highlightBottom - highlightTop + 2
      });
    }

    const lineText = lineTextParts.filter(Boolean).join(" ");

    if (lineText) {
      textParts.push(lineText);
    }
  }

  if (highlights.length === 0) {
    return null;
  }

  return {
    text: textParts.join("\n").trim(),
    highlights
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

function mergeLineHighlight(elements: TextRect[]): HighlightRect | null {
  if (elements.length === 0) {
    return null;
  }

  const page = elements[0].page;
  const pageRect = page.getBoundingClientRect();
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const { rect } of elements) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }

  return {
    page,
    left: left - pageRect.left - 1,
    top: top - pageRect.top - 1,
    width: right - left + 2,
    height: bottom - top + 2
  };
}

function getCharacterRects(element: HTMLElement): DOMRect[] {
  const textNode = element.firstChild;

  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    return [];
  }

  const text = textNode.textContent || "";

  if (text.length === 0) {
    return [];
  }

  const range = document.createRange();
  const rects: DOMRect[] = [];

  for (let i = 0; i < text.length; i += 1) {
    range.setStart(textNode, i);
    range.setEnd(textNode, i + 1);
    const charRect = range.getBoundingClientRect();

    // Some characters (like spaces) may have zero width; use previous rect if available
    if (charRect.width > 0 && charRect.height > 0) {
      rects.push(charRect);
    } else if (rects.length > 0) {
      rects.push(rects[rects.length - 1]);
    } else {
      rects.push(charRect);
    }
  }

  return rects;
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

async function resolveOutline(
  pdfDocument: PdfDocumentProxy
): Promise<PdfOutlineItem[]> {
  const outline = await pdfDocument.getOutline();

  if (!outline) {
    return [];
  }

  return resolveOutlineItems(pdfDocument, outline, "outline");
}

async function resolveOutlineItems(
  pdfDocument: PdfDocumentProxy,
  items: PdfOutlineSourceItem[],
  path: string
): Promise<PdfOutlineItem[]> {
  const resolvedItems = await Promise.all(
    items.map(async (item, index) => {
      const id = `${path}-${index}`;
      const childItems = item.items?.length
        ? await resolveOutlineItems(pdfDocument, item.items, id)
        : [];

      return {
        id,
        title: item.title?.trim() || "Untitled",
        pageNumber: await resolveOutlinePageNumber(pdfDocument, item.dest),
        items: childItems
      };
    })
  );

  return resolvedItems;
}

async function resolveOutlinePageNumber(
  pdfDocument: PdfDocumentProxy,
  dest: string | unknown[] | null | undefined
): Promise<number | null> {
  try {
    const explicitDest = typeof dest === "string"
      ? await pdfDocument.getDestination(dest)
      : dest;
    const pageRef = explicitDest?.[0];

    if (!pageRef) {
      return null;
    }

    if (typeof pageRef === "number") {
      return pageRef + 1;
    }

    return (await pdfDocument.getPageIndex(pageRef)) + 1;
  } catch {
    return null;
  }
}

function scrollToPage(scrollElement: HTMLElement | null, pageNumber: number) {
  const pageElement = scrollElement?.querySelector<HTMLElement>(
    `.pdf-page[data-page-number="${pageNumber}"]`
  );

  if (!scrollElement || !pageElement) {
    return;
  }

  const scrollRect = scrollElement.getBoundingClientRect();
  const pageRect = pageElement.getBoundingClientRect();
  scrollElement.scrollTo({
    top: scrollElement.scrollTop + pageRect.top - scrollRect.top - 16,
    behavior: "smooth"
  });
}

function getScrollAnchor(scrollElement: HTMLElement | null): ScrollAnchor | null {
  if (!scrollElement) {
    return null;
  }

  const scrollRect = scrollElement.getBoundingClientRect();
  const pages = Array.from(
    scrollElement.querySelectorAll<HTMLElement>(".pdf-page")
  );
  let anchorPage: HTMLElement | null = null;
  let bestVisibleHeight = 0;

  for (const page of pages) {
    const pageRect = page.getBoundingClientRect();
    const visibleHeight =
      Math.min(pageRect.bottom, scrollRect.bottom) -
      Math.max(pageRect.top, scrollRect.top);

    if (visibleHeight > bestVisibleHeight) {
      bestVisibleHeight = visibleHeight;
      anchorPage = page;
    }
  }

  if (!anchorPage) {
    return null;
  }

  const pageNumber = Number(anchorPage.dataset.pageNumber) || 0;
  const pageOffset = scrollElement.scrollTop - anchorPage.offsetTop;
  const maxPageOffset = Math.max(anchorPage.offsetHeight, 1);
  const maxScrollLeft = Math.max(
    scrollElement.scrollWidth - scrollElement.clientWidth,
    1
  );

  return {
    pageNumber,
    offsetRatio: clamp(pageOffset / maxPageOffset, 0, 1),
    leftRatio: clamp(scrollElement.scrollLeft / maxScrollLeft, 0, 1)
  };
}

function restoreScrollAnchor(
  scrollElement: HTMLElement | null,
  anchor: ScrollAnchor | null
) {
  if (!scrollElement || !anchor) {
    return;
  }

  const pageElement = scrollElement.querySelector<HTMLElement>(
    `.pdf-page[data-page-number="${anchor.pageNumber}"]`
  );

  if (!pageElement) {
    return;
  }

  const maxScrollLeft = Math.max(
    scrollElement.scrollWidth - scrollElement.clientWidth,
    0
  );

  scrollElement.scrollTo({
    top: pageElement.offsetTop + pageElement.offsetHeight * anchor.offsetRatio,
    left: maxScrollLeft * anchor.leftRatio,
    behavior: "auto"
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getMostVisiblePageNumber(scrollElement: HTMLElement | null): number {
  if (!scrollElement) {
    return 0;
  }

  const scrollRect = scrollElement.getBoundingClientRect();
  const pages = Array.from(
    scrollElement.querySelectorAll<HTMLElement>(".pdf-page")
  );
  let bestPageNumber = 0;
  let bestVisibleHeight = 0;

  for (const page of pages) {
    const pageRect = page.getBoundingClientRect();
    const visibleHeight =
      Math.min(pageRect.bottom, scrollRect.bottom) -
      Math.max(pageRect.top, scrollRect.top);

    if (visibleHeight > bestVisibleHeight) {
      bestVisibleHeight = visibleHeight;
      bestPageNumber = Number(page.dataset.pageNumber) || 0;
    }
  }

  return bestPageNumber;
}
