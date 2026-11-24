import type { BoardItem } from "../model/schema";
import { buildGeometry, type ItemGeometry } from "./items";

/** Caches each item's geometry until the item changes. */
export class ItemCache {
  private readonly entries = new Map<string, { version: number; geometry: ItemGeometry }>();

  /** `version` null means the item is a live preview and is not cached. */
  get(item: BoardItem, version: number | null): ItemGeometry {
    if (version === null) return buildGeometry(item);
    const cached = this.entries.get(item.id);
    if (cached && cached.version === version) return cached.geometry;
    const geometry = buildGeometry(item);
    this.entries.set(item.id, { version, geometry });
    return geometry;
  }

  prune(isLive: (id: string) => boolean): void {
    for (const id of this.entries.keys()) if (!isLive(id)) this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }
}
