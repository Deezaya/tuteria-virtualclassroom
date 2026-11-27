import type { PDFDocumentProxy } from "pdfjs-dist";

/** Most pages one import may add (Excalidraw board only). */
export const maxPdfPages = 20;
/** Largest PDF the new board accepts. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** Page images for the new board: wide enough to read, small enough for phones. */
const BOARD_PAGE_WIDTH = 1600;
const BOARD_PAGE_QUALITY = 0.8;

/** Draws one page on a white canvas of the given width. */
async function drawPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  width: number,
  canvas: HTMLCanvasElement = document.createElement("canvas"),
): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas;
  } finally {
    page.cleanup();
  }
}

/** One page as a JPEG file ready to upload (new board). */
export async function renderPdfPageToBlob(
  pdf: PDFDocumentProxy,
  pageNumber: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const canvas = await drawPage(pdf, pageNumber, BOARD_PAGE_WIDTH);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("Could not draw that page."))),
      "image/jpeg",
      BOARD_PAGE_QUALITY,
    ),
  );
  const size = { width: canvas.width, height: canvas.height };
  // Free the pixels straight away; long PDFs are drawn one page at a time.
  canvas.width = 0;
  canvas.height = 0;
  return { blob, ...size };
}

/** Draws a small preview of a page into an existing canvas. */
export async function renderPdfThumbnail(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  width: number,
): Promise<void> {
  await drawPage(pdf, pageNumber, width, canvas);
}
/** Width, in pixels, each page is drawn at before being saved as a JPEG. */
const renderWidth = 1100;
const jpegQuality = 0.78;

/** Loads PDF.js on demand and opens the file. */
export async function openPdf(file: File): Promise<PDFDocumentProxy> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
  }).promise;
}

/**
 * Reads an answer like "3" or "1-20" and clamps it to the document and to
 * maxPdfPages. Throws Error("range") when the answer cannot be used.
 */
export function parsePageRange(
  answer: string,
  numPages: number,
): { firstPage: number; lastPage: number } {
  const match = answer.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!match) throw new Error("range");
  const firstPage = Math.max(1, Number(match[1]));
  const lastPage = Math.min(
    numPages,
    Number(match[2] ?? match[1]),
    firstPage + maxPdfPages - 1,
  );
  if (firstPage > lastPage) throw new Error("range");
  return { firstPage, lastPage };
}

export type RasterizedPage = {
  dataURL: string;
  /** Pixel size of the drawn image. */
  width: number;
  height: number;
};

/** Draws one page on a white background and returns it as a JPEG data URL. */
export async function rasterizePdfPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
): Promise<RasterizedPage> {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: renderWidth / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  const dataURL = canvas.toDataURL("image/jpeg", jpegQuality);
  page.cleanup();
  return { dataURL, width: canvas.width, height: canvas.height };
}
