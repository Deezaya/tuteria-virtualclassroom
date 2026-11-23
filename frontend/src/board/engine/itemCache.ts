import type { BoardItem } from "../model/schema";
import { itemBounds, type Bounds } from "./geometry";

type Entry = { version: number; path: Path2D; bounds: Bounds };

/**
 * Builds a smooth path through the points: quadratic curves between the
 * midpoints of each pair, which removes the corners of raw pointer input.
 * Coordinates are relative to the item's x and y.
 */
export function buildStrokePath(points: readonly number[]): Path2D {
  const path = new Path2D();
  const count = Math.floor(points.length / 3);
  if (count === 0) return path;
  path.moveTo(points[0], points[1]);
  if (count === 1) {
    // A zero-length line draws nothing; nudge it so a tap leaves a dot.
    path.lineTo(points[0] + 0.01, points[1]);
    return path;
  }
  for (let i = 1; i < count - 1; i += 1) {
    const x = points[i * 3];
    const y = points[i * 3 + 1];
    const nx = points[(i + 1) * 3];
    const ny = points[(i + 1) * 3 + 1];
    path.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  path.lineTo(points[(count - 1) * 3], points[(count - 1) * 3 + 1]);
  return path;
}

/** Caches each item's path and bounds until the item changes. */
export class ItemCache {
  private readonly entries = new Map<string, Entry>();

  /** `version` null means the item is a live preview and is not cached. */
  get(item: BoardItem, version: number | null): Entry {
    if (version === null) {
      return { version: -1, path: buildStrokePath(item.points), bounds: itemBounds(item) };
    }
    const cached = this.entries.get(item.id);
    if (cached && cached.version === version) return cached;
    const entry = { version, path: buildStrokePath(item.points), bounds: itemBounds(item) };
    this.entries.set(item.id, entry);
    return entry;
  }

  prune(isLive: (id: string) => boolean): void {
    for (const id of this.entries.keys()) if (!isLive(id)) this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }
}
