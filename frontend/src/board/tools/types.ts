import type { BoardModel } from "../model/BoardModel";
import type { BoardItem } from "../model/schema";
import type { Camera } from "../engine/camera";
import type { Bounds, Point } from "../engine/geometry";
import type { ItemGeometry } from "../engine/items";

export type ShapeKind = "rect" | "ellipse" | "line" | "arrow";
export type ToolId =
  | "select"
  | "hand"
  | "pen"
  | "highlighter"
  | "eraser"
  | ShapeKind
  | "text"
  | "laser";

export type PointerSample = { world: Point; pressure: number };

export type BoardPointer = {
  screen: Point;
  world: Point;
  pressure: number;
  pointerType: string;
  shiftKey: boolean;
  /** Every position since the last event (coalesced events), oldest first. */
  samples: PointerSample[];
};

/** Current drawing settings. Highlighter keeps its own colour and width. */
export type DrawStyle = {
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  fontSize: number;
  highlighter: string;
  highlighterWidth: number;
};

/** What the engine lets a tool see and do. */
export interface ToolHost {
  /** Null when no board is attached or the person may not edit. */
  getEditableModel(): BoardModel | null;
  getCamera(): Camera;
  setCamera(camera: Camera): void;
  requestRender(): void;
  getStyle(): DrawStyle;
  getSelection(): ReadonlySet<string>;
  setSelection(ids: Iterable<string>): void;
  /** The top-most item within `radius` world units of `world`. */
  hitTest(world: Point, radius: number): BoardItem | null;
  itemsTouching(bounds: Bounds): BoardItem[];
  geometryOf(item: BoardItem): ItemGeometry;
  getItem(id: string): BoardItem | undefined;
  /** All items, bottom first. */
  getItems(): readonly BoardItem[];
  /** Shares this person's laser trail (world points), or clears it. */
  publishLaser(points: Point[] | null): void;
  /** Opens the text editor on a text item. */
  beginTextEdit(id: string, created: boolean): void;
}

export interface Tool {
  readonly id: ToolId;
  /** CSS cursor for the canvas right now. */
  readonly cursor: string;
  /** True when the tool needs edit permission, so read-only mode hides it. */
  readonly edits: boolean;
  down(pointer: BoardPointer): void;
  move(pointer: BoardPointer): void;
  up(pointer: BoardPointer): void;
  /** Pointer moving with no button pressed, or null when it leaves. */
  hover?(pointer: BoardPointer | null): void;
  /** Abandons the gesture and undoes anything it wrote. */
  cancel(): void;
  /** Ends the gesture and keeps what it wrote. */
  finish(): void;
  drawOverlay?(ctx: CanvasRenderingContext2D, camera: Camera): void;
  /** How to draw an item while the tool is changing it (move, resize). */
  overrideItem?(id: string): BoardItem | null;
  hiddenIds?(): ReadonlySet<string>;
  fadedIds?(): ReadonlySet<string>;
  previewItems?(): readonly BoardItem[];
  /** True while the tool needs a redraw every frame (fading laser). */
  isAnimating?(): boolean;
}
