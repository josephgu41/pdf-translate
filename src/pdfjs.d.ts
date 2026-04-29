declare module "pdfjs-dist/build/pdf" {
  export const GlobalWorkerOptions: {
    workerSrc: string;
  };

  export function getDocument(source: { data: Uint8Array }): {
    promise: Promise<{
      numPages: number;
      getPage: (pageNumber: number) => Promise<any>;
    }>;
    destroy: () => Promise<void>;
  };

  export function renderTextLayer(options: {
    container: HTMLElement;
    textContentSource: unknown;
    textDivs: HTMLElement[];
    viewport: unknown;
  }): {
    promise: Promise<void>;
  };
}
