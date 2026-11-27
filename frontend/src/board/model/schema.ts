/**
 * Version 2 board layout. docs/whiteboard-data-layout.md is the source of
 * truth; keep this file in step with it.
 */
import * as Y from "yjs";

export const SCHEMA_VERSION = 2;

export const ROOT_META = "meta";
export const ROOT_ITEMS = "items";
export const ROOT_ASSETS = "assets";
/** Board pages (tabs). Lives in the locked layer, so only hosts can change it. */
export const ROOT_TABS = "tabs";
/** The tab of items written before tabs existed, and of a board with no tab list yet. */
export const DEFAULT_TAB_ID = "main";
export const DEFAULT_TAB_NAME = "Page 1";
export const MAX_TAB_NAME = 40;
/** Version 1 (Excalidraw) roots. Read only to detect an old board. */
export const LEGACY_ROOT_ELEMENTS = "elements";

/** Board text uses the app's font. */
export const BOARD_FONT = "Sora";
export const TEXT_LINE_HEIGHT = 1.25;

export type StrokeTool = "pen" | "highlighter";
export type TextAlign = "left" | "center" | "right";

type ItemBase = {
  id: string;
  x: number;
  y: number;
  /** Radians, around the centre of the item's box. Strokes and lines stay 0. */
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
  /** The tab (board page) this item is on. */
  tab: string;
};

export type StrokeItem = ItemBase & {
  type: "stroke";
  tool: StrokeTool;
  /** Flat [x, y, pressure, …], relative to the item's x and y. */
  points: number[];
  done: boolean;
};

export type RectItem = ItemBase & { type: "rect"; w: number; h: number };
export type EllipseItem = ItemBase & { type: "ellipse"; w: number; h: number };

export type LineItem = ItemBase & {
  type: "line" | "arrow";
  /** [x1, y1, x2, y2], relative to the item's x and y. */
  points: number[];
  arrowStart: boolean;
  arrowEnd: boolean;
};

export type TextItem = ItemBase & {
  type: "text";
  text: string;
  fontSize: number;
  fontFamily: string;
  align: TextAlign;
  /** Wrap width in world units, or null to grow with the text. */
  w: number | null;
};

export type ImageItem = ItemBase & { type: "image"; assetId: string; w: number; h: number };

/** One page of an imported PDF, stored as an image. */
export type PdfPageItem = ItemBase & {
  type: "pdfPage";
  assetId: string;
  w: number;
  h: number;
  /** Shared by every page of one import, so the whole PDF can be removed. */
  pdfId: string;
  pdfName: string;
  pageNumber: number;
};

export type BoardItem =
  | StrokeItem
  | RectItem
  | EllipseItem
  | LineItem
  | TextItem
  | ImageItem
  | PdfPageItem;
export type ItemType = BoardItem["type"];

/** Items with a box that can be resized and rotated. */
export type BoxItem = RectItem | EllipseItem | TextItem | ImageItem | PdfPageItem;

export type BoardAsset = {
  id: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  /** R2 object key. Viewing it needs a short-lived link from the backend. */
  key: string | null;
  /** Unused; kept so older documents still read. */
  url: string | null;
  /** Phase 2 only: the image itself, inline. New images never use this. */
  dataURL: string | null;
  createdBy: string;
};

export type ItemMap = Y.Map<unknown>;

function num(map: Y.Map<unknown>, key: string, fallback: number): number {
  const value = map.get(key);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(map: Y.Map<unknown>, key: string, fallback: string): string {
  const value = map.get(key);
  return typeof value === "string" ? value : fallback;
}

function numbers(value: unknown): number[] {
  if (value instanceof Y.Array) return value.toArray().filter((n): n is number => typeof n === "number");
  if (Array.isArray(value)) return value.filter((n): n is number => typeof n === "number");
  return [];
}

/**
 * Reads one item into a plain object. Returns null for item types this
 * client does not know, so a newer client's items are skipped, not broken.
 */
export function readItem(id: string, map: ItemMap): BoardItem | null {
  const fill = map.get("fill");
  const base: ItemBase = {
    id,
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
    tab: str(map, "tab", DEFAULT_TAB_ID),
  };
  const type = map.get("type");
  switch (type) {
    case "stroke":
      return {
        ...base,
        type,
        rotation: 0,
        tool: map.get("tool") === "highlighter" ? "highlighter" : "pen",
        points: numbers(map.get("points")),
        done: map.get("done") === true,
      };
    case "rect":
    case "ellipse":
      return { ...base, type, w: num(map, "w", 1), h: num(map, "h", 1) };
    case "line":
    case "arrow": {
      const points = numbers(map.get("points"));
      return {
        ...base,
        type,
        rotation: 0,
        points: points.length >= 4 ? points.slice(0, 4) : [0, 0, 0, 0],
        arrowStart: map.get("arrowStart") === true,
        arrowEnd: map.get("arrowEnd") === true,
      };
    }
    case "text": {
      const text = map.get("text");
      const align = map.get("align");
      const w = map.get("w");
      return {
        ...base,
        type,
        text: text instanceof Y.Text ? text.toString() : typeof text === "string" ? text : "",
        fontSize: num(map, "fontSize", 24),
        fontFamily: str(map, "fontFamily", BOARD_FONT),
        align: align === "center" || align === "right" ? align : "left",
        w: typeof w === "number" && Number.isFinite(w) ? w : null,
      };
    }
    case "image":
      return {
        ...base,
        type,
        assetId: str(map, "assetId", ""),
        w: num(map, "w", 1),
        h: num(map, "h", 1),
      };
    case "pdfPage":
      return {
        ...base,
        type,
        assetId: str(map, "assetId", ""),
        w: num(map, "w", 1),
        h: num(map, "h", 1),
        pdfId: str(map, "pdfId", ""),
        pdfName: str(map, "pdfName", ""),
        pageNumber: num(map, "pageNumber", 1),
      };
    default:
      return null;
  }
}

export function readAsset(id: string, map: Y.Map<unknown>): BoardAsset {
  const key = map.get("key");
  const url = map.get("url");
  const dataURL = map.get("dataURL");
  return {
    id,
    mime: str(map, "mime", "image/jpeg"),
    width: num(map, "width", 1),
    height: num(map, "height", 1),
    bytes: num(map, "bytes", 0),
    key: typeof key === "string" ? key : null,
    url: typeof url === "string" ? url : null,
    dataURL: typeof dataURL === "string" ? dataURL : null,
    createdBy: str(map, "createdBy", ""),
  };
}

/** One board page. */
export type BoardTab = {
  id: string;
  name: string;
  /** Fractional index: tabs are shown in this order. */
  z: string;
  /** Set on tabs made by "each page on its own tab", so the PDF can be removed from its tab. */
  pdfId: string | null;
};

export function readTab(id: string, map: Y.Map<unknown>): BoardTab {
  const pdfId = map.get("pdfId");
  const name = str(map, "name", "").trim();
  return {
    id,
    name: (name || "Page").slice(0, MAX_TAB_NAME),
    z: str(map, "z", ""),
    pdfId: typeof pdfId === "string" && pdfId ? pdfId : null,
  };
}

export function compareTabs(a: BoardTab, b: BoardTab): number {
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Leading Mode, stored in the locked layer's `meta.leading`. */
export type Leading = { by: string; name: string };

export function readLeading(value: unknown): Leading | null {
  if (typeof value !== "object" || value === null) return null;
  const { by, name } = value as Record<string, unknown>;
  if (typeof by !== "string" || !by) return null;
  return { by, name: typeof name === "string" && name ? name.slice(0, 80) : "Tutor" };
}

export function isBoxItem(item: BoardItem): item is BoxItem {
  return (
    item.type === "rect" ||
    item.type === "ellipse" ||
    item.type === "text" ||
    item.type === "image" ||
    item.type === "pdfPage"
  );
}

/** Images and PDF pages: pictures that keep their shape when resized. */
export function isPicture(item: BoardItem): item is ImageItem | PdfPageItem {
  return item.type === "image" || item.type === "pdfPage";
}

/** Sort order for drawing: z key, then id so ties look the same everywhere. */
export function compareItems(a: BoardItem, b: BoardItem): number {
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
