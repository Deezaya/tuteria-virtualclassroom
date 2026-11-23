import type { BoardModel } from "../model/BoardModel";
import type { BoardItem } from "../model/schema";
import type { Camera } from "../engine/camera";
import type { Bounds, Point } from "../engine/geometry";

/** Phase 2 adds highlighter, shapes, text, laser, image and PDF tools. */
export type ToolId = "select" | "hand" | "pen" | "eraser";

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

export type DrawStyle = { stroke: string; strokeWidth: number };

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
  boundsOf(item: BoardItem): Bounds;
  /** All items, bottom first. */
  getItems(): readonly BoardItem[];
}

export interface Tool {
  readonly id: ToolId;
  /** CSS cursor for the canvas right now. */
  readonly cursor: string;
  /** True when the tool writes to the board, so read-only mode hides it. */
  readonly edits: boolean;
  down(pointer: BoardPointer): void;
  move(pointer: BoardPointer): void;
  up(pointer: BoardPointer): void;
  /** Pointer moving with no button pressed. */
  hover?(pointer: BoardPointer | null): void;
  /** Abandons the gesture and undoes anything it wrote. */
  cancel(): void;
  /** Ends the gesture and keeps what it wrote. */
  finish(): void;
  drawOverlay?(ctx: CanvasRenderingContext2D, camera: Camera): void;
  /** Where to draw an item instead of its saved position (live move). */
  positionOverride?(id: string): Point | null;
  hiddenIds?(): ReadonlySet<string>;
  fadedIds?(): ReadonlySet<string>;
  previewItems?(): readonly BoardItem[];
}
