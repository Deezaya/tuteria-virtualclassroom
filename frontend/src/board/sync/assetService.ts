import {
  ApiError,
  getBoardAssetUrls,
  requestBoardUpload,
  type BoardUploadKind,
} from "../../api/client";

/** Board file storage as the engine and the upload dialog see it. */
export interface AssetService {
  /** Uploads one file to storage and returns its asset id and key. */
  upload(
    file: Blob,
    kind: BoardUploadKind,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<{ assetId: string; key: string }>;
  /** A link to view a stored file, or null while one is being fetched. */
  viewUrl(key: string): string | null;
}

/** An upload problem with a message fit to show people. */
export class UploadError extends Error {}

/** Signed view links are renewed this long before they expire. */
const RENEW_EARLY_MS = 5 * 60 * 1000;
const RETRY_FAILED_MS = 15 * 1000;
const BATCH_DELAY_MS = 30;
const MAX_BATCH = 100;

function put(
  url: string,
  file: Blob,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Cancelled", "AbortError"));
      return;
    }
    // XMLHttpRequest, because fetch can't report upload progress.
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new UploadError(`Storage refused the file (error ${xhr.status}). Please try again.`));
    };
    xhr.onerror = () => reject(new UploadError("Upload failed. Check your connection and try again."));
    xhr.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/**
 * Talks to the backend for upload and view links. View links are fetched
 * in batches and cached until shortly before they expire.
 */
export function createAssetService(sessionId: string, onUrlsReady: () => void): AssetService {
  const urls = new Map<string, { url: string; renewAt: number }>();
  const retryAt = new Map<string, number>();
  const queued = new Set<string>();
  const inFlight = new Set<string>();
  let timer: number | null = null;

  async function flush() {
    timer = null;
    const keys = [...queued].slice(0, MAX_BATCH);
    keys.forEach((key) => {
      queued.delete(key);
      inFlight.add(key);
    });
    if (queued.size > 0) timer = window.setTimeout(flush, BATCH_DELAY_MS);
    try {
      const result = await getBoardAssetUrls(sessionId, keys);
      const renewAt = Date.now() + result.expiresIn * 1000 - RENEW_EARLY_MS;
      for (const key of keys) {
        const url = result.urls[key];
        if (url) urls.set(key, { url, renewAt });
        else retryAt.set(key, Date.now() + RETRY_FAILED_MS);
      }
      onUrlsReady();
    } catch {
      keys.forEach((key) => retryAt.set(key, Date.now() + RETRY_FAILED_MS));
    } finally {
      keys.forEach((key) => inFlight.delete(key));
    }
  }

  return {
    async upload(file, kind, onProgress, signal) {
      let target;
      try {
        target = await requestBoardUpload(sessionId, {
          kind,
          contentType: file.type,
          bytes: file.size,
        });
      } catch (error) {
        if (error instanceof ApiError) throw new UploadError(error.message);
        throw new UploadError("Upload failed. Check your connection and try again.");
      }
      try {
        await put(target.uploadUrl, file, onProgress, signal);
      } catch (error) {
        // One quiet retry helps on patchy mobile connections.
        if (error instanceof UploadError && !signal?.aborted) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          await put(target.uploadUrl, file, onProgress, signal);
        } else {
          throw error;
        }
      }
      return { assetId: target.assetId, key: target.key };
    },

    viewUrl(key) {
      const cached = urls.get(key);
      const now = Date.now();
      if (cached && cached.renewAt > now) return cached.url;
      if (!inFlight.has(key) && !queued.has(key) && (retryAt.get(key) ?? 0) <= now) {
        queued.add(key);
        if (timer === null) timer = window.setTimeout(flush, BATCH_DELAY_MS);
      }
      // An older link is still good for a few minutes while a new one loads.
      return cached?.url ?? null;
    },
  };
}
