/**
 * Prepares an image file for the board: shrinks it to at most 1600 px on
 * its long side and compresses it, so it loads quickly on weak networks.
 * The result is uploaded to storage; the board keeps only a reference.
 */
export const MAX_IMAGE_SIDE = 1600;
/** Must stay at or under the backend's limit for images (10 MB). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export class ImageImportError extends Error {}

export type PreparedImage = {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
};

async function decode(file: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall back to an <img> below.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new ImageImportError("Could not prepare that image."))),
      mime,
      quality,
    );
  });
}

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) {
    throw new ImageImportError("That file isn't an image.");
  }
  let source: CanvasImageSource & { width: number; height: number };
  try {
    source = await decode(file);
  } catch {
    throw new ImageImportError("Could not read that image.");
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageImportError("Could not read that image.");

  // Keep transparency for PNG-like files when the result isn't too big.
  const mayHaveAlpha = file.type === "image/png" || file.type === "image/gif" || file.type === "image/webp";
  if (mayHaveAlpha) {
    ctx.drawImage(source, 0, 0, width, height);
    const png = await canvasToBlob(canvas, "image/png");
    if (png.size <= 2 * 1024 * 1024) return { blob: png, mime: "image/png", width, height };
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  for (const quality of [0.85, 0.7]) {
    const jpeg = await canvasToBlob(canvas, "image/jpeg", quality);
    if (jpeg.size <= MAX_IMAGE_BYTES) return { blob: jpeg, mime: "image/jpeg", width, height };
  }
  throw new ImageImportError("That image is too large to add.");
}
