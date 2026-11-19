import type { PDFDocumentProxy } from "pdfjs-dist";

/** Most pages one import may add. */
export const maxPdfPages = 20;
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
