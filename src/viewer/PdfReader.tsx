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

const WHEEL_ZOOM_STEP = 0.2;

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

type ScrollAnchor = {
  pageNumber: number;
  offsetRatio: number;
  leftRatio: number;
};

type HighlightRect = {
  page: HTMLElement;
  left: number;
  top: number;
  width: number;
  height: number;
};

type TextSegment = HighlightRect & {
  text: string;
  start: number;
  end: number;
  lineIndex: number;
};

type TextLine = HighlightRect & {
  start: number;
  end: number;
  segments: TextSegment[];
};

type TextSelectionModel = {
  text: string;
  lines: TextLine[];
  segments: TextSegment[];
};

type TextHit = {
  offset: number;
};

type DragSelection = {
  pointerId: number;
  start: TextHit;
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
  const selectionModelRef = useRef<TextSelectionModel | null>(null);
  const dragSelectionRef = useRef<DragSelection | null>(null);
  const [renderState, setRenderState] = useState<RenderState>({ status: "idle" });

  useEffect(() => {
    const pagesElement = pagesRef.current;

    if (!pagesElement) {
      return;
    }

    if (!fileData) {
      pagesElement.innerHTML = "";
      selectionModelRef.current = null;
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
      selectionModelRef.current = null;
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
        selectionModelRef.current = buildTextSelectionModel(pageContainer);
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
      dragSelectionRef.current = null;
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
    const scrollElement = scrollRef.current;
    const model = selectionModelRef.current;
    const hit = model
      ? getTextHitAtPoint(model, event.clientX, event.clientY)
      : null;

    clearGeometryHighlight(scrollRef.current);
    window.getSelection()?.removeAllRanges();

    if (!scrollElement || !hit || event.button !== 0) {
      dragSelectionRef.current = null;
      onSelectionChange("");
      return;
    }

    event.preventDefault();
    scrollElement.setPointerCapture(event.pointerId);
    dragSelectionRef.current = {
      pointerId: event.pointerId,
      start: hit
    };
    onSelectionChange("");
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const dragSelection = dragSelectionRef.current;
    const scrollElement = scrollRef.current;
    const model = selectionModelRef.current;

    if (!dragSelection || !scrollElement || !model) {
      return;
    }

    const hit = getTextHitAtPoint(model, event.clientX, event.clientY);

    if (!hit) {
      return;
    }

    const selection = getCustomSelection(model, dragSelection.start, hit);
    applyGeometryHighlight(scrollElement, selection.highlights);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const dragSelection = dragSelectionRef.current;
    const scrollElement = scrollRef.current;
    const model = selectionModelRef.current;

    if (!dragSelection || dragSelection.pointerId !== event.pointerId) {
      return;
    }

    dragSelectionRef.current = null;
    if (scrollElement?.hasPointerCapture(event.pointerId)) {
      scrollElement.releasePointerCapture(event.pointerId);
    }

    if (!scrollElement || !model) {
      return;
    }

    const hit = getTextHitAtPoint(model, event.clientX, event.clientY);

    if (!hit) {
      clearGeometryHighlight(scrollElement);
      onSelectionChange("");
      return;
    }

    const selection = getCustomSelection(model, dragSelection.start, hit);
    applyGeometryHighlight(scrollElement, selection.highlights);
    onSelectionChange(selection.text.trim());
  };

  const handleNativeSelection = () => {
    const scrollElement = scrollRef.current;
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

    const selectedText = selection.toString().trim();

    if (!selectedText) {
      clearGeometryHighlight(scrollElement);
      return;
    }

    applyGeometryHighlight(scrollElement, getSelectionHighlightRects(scrollElement, selection));
    onSelectionChange(selectedText);
  };

  const handleKeyboardSelection = (_event: KeyboardEvent<HTMLDivElement>) => {
    handleNativeSelection();
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    event.preventDefault();
    onZoomByDelta(event.deltaY < 0 ? WHEEL_ZOOM_STEP : -WHEEL_ZOOM_STEP);
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
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
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

function buildTextSelectionModel(container: HTMLElement): TextSelectionModel {
  const pages = Array.from(container.querySelectorAll<HTMLElement>(".pdf-page"));
  const lineCandidates: Array<Omit<TextLine, "start" | "end" | "segments"> & {
    segments: Array<Omit<TextSegment, "start" | "end" | "lineIndex">>;
  }> = [];

  for (const page of pages) {
    const pageRect = page.getBoundingClientRect();
    const textElements = Array.from(
      page.querySelectorAll<HTMLElement>(".textLayer span")
    )
      .map((element) => {
        const text = element.textContent ?? "";
        const rect = element.getBoundingClientRect();

        if (!text || rect.width <= 0 || rect.height <= 0) {
          return null;
        }

        return {
          page,
          text,
          left: rect.left - pageRect.left,
          top: rect.top - pageRect.top,
          width: rect.width,
          height: rect.height
        };
      })
      .filter((segment): segment is Omit<TextSegment, "start" | "end" | "lineIndex"> =>
        segment !== null
      )
      .sort((a, b) => a.top - b.top || a.left - b.left);

    for (const segment of textElements) {
      const segmentCenter = segment.top + segment.height / 2;
      const matchingLine = lineCandidates.find((line) => {
        const lineCenter = line.top + line.height / 2;
        return (
          line.page === segment.page &&
          Math.abs(segmentCenter - lineCenter) <=
            Math.max(4, Math.min(line.height, segment.height) * 0.65)
        );
      });

      if (matchingLine) {
        matchingLine.segments.push(segment);
        const right = Math.max(matchingLine.left + matchingLine.width, segment.left + segment.width);
        const bottom = Math.max(matchingLine.top + matchingLine.height, segment.top + segment.height);
        matchingLine.left = Math.min(matchingLine.left, segment.left);
        matchingLine.top = Math.min(matchingLine.top, segment.top);
        matchingLine.width = right - matchingLine.left;
        matchingLine.height = bottom - matchingLine.top;
      } else {
        lineCandidates.push({
          page: segment.page,
          left: segment.left,
          top: segment.top,
          width: segment.width,
          height: segment.height,
          segments: [segment]
        });
      }
    }
  }

  lineCandidates.sort((a, b) => {
    const pageA = Number(a.page.dataset.pageNumber) || 0;
    const pageB = Number(b.page.dataset.pageNumber) || 0;
    return pageA - pageB || a.top - b.top || a.left - b.left;
  });

  let text = "";
  const lines: TextLine[] = [];
  const segments: TextSegment[] = [];

  lineCandidates.forEach((lineCandidate, lineIndex) => {
    if (text) {
      text += "\n";
    }

    lineCandidate.segments.sort((a, b) => a.left - b.left);
    const lineStart = text.length;

    lineCandidate.segments.forEach((segment, segmentIndex) => {
      const previous = lineCandidate.segments[segmentIndex - 1];

      if (
        previous &&
        shouldInsertSpaceBetweenSegments(previous, segment, text[text.length - 1])
      ) {
        text += " ";
      }

      const start = text.length;
      text += segment.text;
      const end = text.length;
      segments.push({
        ...segment,
        start,
        end,
        lineIndex
      });
    });

    lines.push({
      page: lineCandidate.page,
      left: lineCandidate.left,
      top: lineCandidate.top,
      width: lineCandidate.width,
      height: lineCandidate.height,
      start: lineStart,
      end: text.length,
      segments: segments.filter((segment) => segment.lineIndex === lineIndex)
    });
  });

  return { text, lines, segments };
}

function shouldInsertSpaceBetweenSegments(
  previous: Pick<TextSegment, "text" | "left" | "width">,
  next: Pick<TextSegment, "text" | "left" | "width">,
  lastCharacter: string | undefined
): boolean {
  if (!lastCharacter || /\s/.test(lastCharacter) || /^\s/.test(next.text)) {
    return false;
  }

  const gap = next.left - (previous.left + previous.width);
  const averageCharacterWidth = previous.width / Math.max(previous.text.length, 1);

  return gap > averageCharacterWidth * 0.75;
}

function getTextHitAtPoint(
  model: TextSelectionModel,
  clientX: number,
  clientY: number
): TextHit | null {
  const page = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>(".pdf-page");

  if (!page) {
    return null;
  }

  const pageRect = page.getBoundingClientRect();
  const x = clientX - pageRect.left;
  const y = clientY - pageRect.top;
  const pageLines = model.lines.filter((line) => line.page === page);

  if (!pageLines.length) {
    return null;
  }

  const line = pageLines.reduce((bestLine, nextLine) => {
    const bestDistance = getLineDistance(bestLine, y);
    const nextDistance = getLineDistance(nextLine, y);
    return nextDistance < bestDistance ? nextLine : bestLine;
  });

  if (getLineDistance(line, y) > Math.max(12, line.height * 1.4)) {
    return null;
  }

  if (x <= line.left) {
    return { offset: line.start };
  }

  if (x >= line.left + line.width) {
    return { offset: line.end };
  }

  const containingSegment = line.segments.find((segment) =>
    x >= segment.left && x <= segment.left + segment.width
  );

  if (containingSegment) {
    return {
      offset: getSegmentOffset(containingSegment, x)
    };
  }

  const previousSegment = [...line.segments]
    .reverse()
    .find((segment) => segment.left + segment.width < x);
  const nextSegment = line.segments.find((segment) => segment.left > x);

  if (previousSegment && nextSegment) {
    const previousRight = previousSegment.left + previousSegment.width;
    const middle = previousRight + (nextSegment.left - previousRight) / 2;
    return {
      offset: x < middle ? previousSegment.end : nextSegment.start
    };
  }

  if (previousSegment) {
    return { offset: previousSegment.end };
  }

  if (nextSegment) {
    return { offset: nextSegment.start };
  }

  return { offset: line.start };
}

function getLineDistance(line: TextLine, y: number): number {
  if (y >= line.top && y <= line.top + line.height) {
    return 0;
  }

  const center = line.top + line.height / 2;
  return Math.abs(y - center);
}

function getSegmentOffset(segment: TextSegment, x: number): number {
  const characterWidth = segment.width / Math.max(segment.text.length, 1);
  const localOffset = Math.round((x - segment.left) / characterWidth);

  return clamp(segment.start + localOffset, segment.start, segment.end);
}

function getCustomSelection(
  model: TextSelectionModel,
  startHit: TextHit,
  endHit: TextHit
): { text: string; highlights: HighlightRect[] } {
  const start = Math.min(startHit.offset, endHit.offset);
  const end = Math.max(startHit.offset, endHit.offset);

  if (end <= start) {
    return { text: "", highlights: [] };
  }

  return {
    text: model.text.slice(start, end),
    highlights: getCustomSelectionHighlightRects(model, start, end)
  };
}

function getCustomSelectionHighlightRects(
  model: TextSelectionModel,
  selectionStart: number,
  selectionEnd: number
): HighlightRect[] {
  const highlights: HighlightRect[] = [];

  for (const segment of model.segments) {
    const start = Math.max(selectionStart, segment.start);
    const end = Math.min(selectionEnd, segment.end);

    if (end <= start) {
      continue;
    }

    const characterWidth = segment.width / Math.max(segment.text.length, 1);
    const left = segment.left + (start - segment.start) * characterWidth;
    const width = (end - start) * characterWidth;

    highlights.push({
      page: segment.page,
      left,
      top: segment.top,
      width,
      height: segment.height
    });
  }

  return highlights;
}

function getSelectionHighlightRects(
  scrollElement: HTMLElement,
  selection: Selection
): HighlightRect[] {
  const pages = Array.from(
    scrollElement.querySelectorAll<HTMLElement>(".pdf-page")
  ).map((page) => ({
    page,
    rect: page.getBoundingClientRect()
  }));
  const highlights: HighlightRect[] = [];

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);

    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      const pageMatch = pages.find(({ rect: pageRect }) =>
        rect.bottom > pageRect.top &&
        rect.top < pageRect.bottom &&
        rect.right > pageRect.left &&
        rect.left < pageRect.right
      );

      if (!pageMatch) {
        continue;
      }

      const { page, rect: pageRect } = pageMatch;
      const left = Math.max(rect.left, pageRect.left);
      const top = Math.max(rect.top, pageRect.top);
      const right = Math.min(rect.right, pageRect.right);
      const bottom = Math.min(rect.bottom, pageRect.bottom);

      if (right <= left || bottom <= top) {
        continue;
      }

      highlights.push({
        page,
        left: left - pageRect.left,
        top: top - pageRect.top,
        width: right - left,
        height: bottom - top
      });
    }
  }

  return highlights;
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
