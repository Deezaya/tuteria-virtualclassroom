type Entry = { src: string; image: HTMLImageElement; ready: boolean; failed: boolean };

/**
 * Decodes board images once and asks for a redraw when each is ready.
 * Images are only requested for items near the view, so a long PDF loads
 * page by page as people scroll.
 */
export class ImageStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly onLoad: () => void) {}

  get(assetId: string, src: string | null): HTMLImageElement | null {
    const existing = this.entries.get(assetId);
    // A loaded image stays, even when its signed link is renewed.
    if (existing?.ready) return existing.image;
    if (!src) return null;
    // Same link: still loading, or failed. A failed load is only retried
    // once the link has been renewed.
    if (existing && existing.src === src) return null;
    const image = new Image();
    image.decoding = "async";
    const created: Entry = { src, image, ready: false, failed: false };
    image.onload = () => {
      created.ready = true;
      this.onLoad();
    };
    image.onerror = () => {
      created.failed = true;
    };
    image.src = src;
    this.entries.set(assetId, created);
    return null;
  }

  clear(): void {
    this.entries.clear();
  }
}
