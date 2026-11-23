/**
 * Version 2 board layout. docs/whiteboard-data-layout.md is the source of
 * truth; keep this file in step with it.
 */
import * as Y from "yjs";

export const SCHEMA_VERSION = 2;

export const ROOT_META = "meta";
export const ROOT_ITEMS = "items";
export const ROOT_ASSETS = "assets";
/** Version 1 (Excalidraw) roots. Read only to detect an old board. */
export const LEGACY_ROOT_ELEMENTS = "elements";

export type StrokeTool = "pen" | "highlighter";

type ItemBase = {
  id: string;
  x: number;
  y: number;
  rotation: number;
  z: string;
  createdBy: string;
  createdAt: number;
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  opacity: number;
  /** Phase 4 moves enforcement to the locked-layer document. */
  locked: boolean;
};

export type StrokeItem = ItemBase & {
  type: "stroke";
  tool: StrokeTool;
  /** Flat [x, y, pressure, …], relative to the item's x and y. */
  points: number[];
  done: boolean;
};

/** Phase 2 adds rect, ellipse, line, arrow, text, image and pdfPage. */
export type BoardItem = StrokeItem;

export type ItemMap = Y.Map<unknown>;

function num(map: ItemMap, key: string, fallback: number): number {
  const value = map.get(key);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(map: ItemMap, key: string, fallback: string): string {
  const value = map.get(key);
  return typeof value === "string" ? value : fallback;
}

/**
 * Reads one item into a plain object. Returns null for item types this
 * client does not know, so a newer client's items are skipped, not broken.
 */
export function readItem(id: string, map: ItemMap): BoardItem | null {
  const type = map.get("type");
  if (type !== "stroke") return null;
  const rawPoints = map.get("points");
  const points =
    rawPoints instanceof Y.Array ? (rawPoints.toArray() as number[]) : [];
  const fill = map.get("fill");
  return {
    id,
    type: "stroke",
    x: num(map, "x", 0),
    y: num(map, "y", 0),
    rotation: num(map, "rotation", 0),
    z: str(map, "z", ""),
    createdBy: str(map, "createdBy", ""),
    createdAt: num(map, "createdAt", 0),
    stroke: str(map, "stroke", "#1f2937"),
    fill: typeof fill === "string" ? fill : null,
    strokeWidth: num(map, "strokeWidth", 3),
    opacity: num(map, "opacity", 1),
    locked: map.get("locked") === true,
    tool: map.get("tool") === "highlighter" ? "highlighter" : "pen",
    points,
    done: map.get("done") === true,
  };
}

/** Sort order for drawing: z key, then id so ties look the same everywhere. */
export function compareItems(a: BoardItem, b: BoardItem): number {
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
