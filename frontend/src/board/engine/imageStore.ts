type Entry = { src: string; image: HTMLImageElement; ready: boolean };

/** Decodes board images once and asks for a redraw when each is ready. */
export class ImageStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly onLoad: () => void) {}

  get(assetId: string, src: string | null): HTMLImageElement | null {
    if (!src) return null;
    let entry = this.entries.get(assetId);
    if (!entry || entry.src !== src) {
      const image = new Image();
      image.decoding = "async";
      const created: Entry = { src, image, ready: false };
      image.onload = () => {
        created.ready = true;
        this.onLoad();
      };
      image.src = src;
      entry = created;
      this.entries.set(assetId, entry);
    }
    return entry.ready ? entry.image : null;
  }

  clear(): void {
    this.entries.clear();
  }
}
