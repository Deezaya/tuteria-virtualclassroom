/**
 * Prepares an image file for the board: shrinks it to at most 1600 px on
 * its long side and compresses it. Until R2 storage (Phase 3) the result is
 * stored inside the board, so it must stay under MAX_IMAGE_BYTES.
 */
export const MAX_IMAGE_SIDE = 1600;
export const MAX_IMAGE_BYTES = 1_000_000;

export class ImageImportError extends Error {}

export type PreparedImage = {
  dataURL: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
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

function dataUrlBytes(dataURL: string): number {
  const comma = dataURL.indexOf(",");
  return Math.floor(((dataURL.length - comma - 1) * 3) / 4);
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

  // Keep transparency for PNG-like files when they fit; otherwise use JPEG.
  const mayHaveAlpha = file.type === "image/png" || file.type === "image/gif" || file.type === "image/webp";
  if (mayHaveAlpha) {
    ctx.drawImage(source, 0, 0, width, height);
    const png = canvas.toDataURL("image/png");
    if (dataUrlBytes(png) <= MAX_IMAGE_BYTES) {
      return { dataURL: png, mime: "image/png", width, height, bytes: dataUrlBytes(png) };
    }
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  for (const quality of [0.85, 0.7, 0.55]) {
    const jpeg = canvas.toDataURL("image/jpeg", quality);
    if (dataUrlBytes(jpeg) <= MAX_IMAGE_BYTES) {
      return { dataURL: jpeg, mime: "image/jpeg", width, height, bytes: dataUrlBytes(jpeg) };
    }
  }
  throw new ImageImportError(
    "This image is too large for now. Bigger images will work once file storage is added.",
  );
}
