import { worldToScreen, type Camera } from "../engine/camera";
import { boundsFromPoints, rotatePoint, type Point } from "../engine/geometry";
import {
  boxCenter,
  cursorForHandle,
  handleAt,
  handlesFor,
  HANDLE_DIRECTIONS,
  type ResizeHandleId,
} from "../engine/handles";
import type { Box } from "../engine/items";
import { BOARD_COLORS } from "../engine/renderer";
import type { ItemPatch } from "../model/BoardModel";
import { isBoxItem, isPicture, type BoardItem, type BoxItem, type LineItem } from "../model/schema";
import type { BoardPointer, Tool, ToolHost } from "./types";

/** How often a change in progress is written, so others see it live. */
const COMMIT_MS = 50;
/** Click tolerance around thin items, in screen pixels. */
const HIT_PX = 6;
const HANDLE_PX = { mouse: 9, touch: 16 };
const DOUBLE_CLICK_MS = 400;
const MIN_SIZE = 4;
const ROTATE_SNAP = Math.PI / 12;

type MoveState = {
  kind: "move";
  start: Point;
  starts: Map<string, BoardItem>;
  offset: Point;
};
type MarqueeState = { kind: "marquee"; start: Point; current: Point; base: Set<string> };
type ResizeState = { kind: "resize"; handle: ResizeHandleId; startItem: BoxItem; startBox: Box; current: BoxItem };
type RotateState = { kind: "rotate"; center: Point; current: BoxItem };
type EndpointState = { kind: "endpoint"; end: "start" | "end"; current: LineItem };
type State = MoveState | MarqueeState | ResizeState | RotateState | EndpointState;

/**
 * Resizes a box from one handle while the opposite side stays put, in the
 * box's own rotated frame.
 */
export function resizeBox(start: Box, handle: ResizeHandleId, pointer: Point, keepAspect: boolean): Box {
  const { hx, hy } = HANDLE_DIRECTIONS[handle];
  const center = boxCenter(start);
  const anchor = rotatePoint(
    { x: center.x - (hx * start.w) / 2, y: center.y - (hy * start.h) / 2 },
    center,
    start.rotation,
  );
  const local = rotatePoint(pointer, anchor, -start.rotation);
  let w = hx !== 0 ? Math.max(MIN_SIZE, (local.x - anchor.x) * hx) : start.w;
  let h = hy !== 0 ? Math.max(MIN_SIZE, (local.y - anchor.y) * hy) : start.h;
  if (keepAspect && hx !== 0 && hy !== 0) {
    const scale = Math.max(w / start.w, h / start.h);
    w = start.w * scale;
    h = start.h * scale;
  }
  const newCenter = rotatePoint(
    { x: anchor.x + (hx * w) / 2, y: anchor.y + (hy * h) / 2 },
    anchor,
    start.rotation,
  );
  return { x: newCenter.x - w / 2, y: newCenter.y - h / 2, w, h, rotation: start.rotation };
}

function normalizeAngle(angle: number): number {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a <= -Math.PI) a += Math.PI * 2;
  return Math.abs(a) < 1e-6 ? 0 : a;
}

/** Click or drag a box to select; drag to move; handles resize and rotate. */
export class SelectTool implements Tool {
  readonly id = "select" as const;
  readonly edits = true;
  private state: State | null = null;
  private hoverCursor = "default";
  private timer: number | null = null;
  private committed = false;
  private lastDown: { id: string; at: number } | null = null;
  /** Locked items can be picked only by tutors and admins (to delete them). */
  private readonly selectable = (item: BoardItem) => this.host.canSelect(item);

  constructor(private readonly host: ToolHost) {}

  get cursor(): string {
    if (this.state?.kind === "move" || this.state?.kind === "rotate") return "grabbing";
    return this.hoverCursor;
  }

  down(pointer: BoardPointer): void {
    const model = this.host.getEditableModel();
    if (!model) return;
    this.committed = false;

    const handle = this.handleUnder(pointer);
    if (handle) {
      const { item, id } = handle;
      model.endStep();
      if (id === "start" || id === "end") {
        if (item.type === "line" || item.type === "arrow") {
          this.state = { kind: "endpoint", end: id, current: item };
        }
        return;
      }
      if (!isBoxItem(item)) return;
      const box = this.host.geometryOf(item).box;
      if (!box) return;
      this.state =
        id === "rotate"
          ? { kind: "rotate", center: boxCenter(box), current: item }
          : { kind: "resize", handle: id, startItem: item, startBox: box, current: item };
      return;
    }

    const hit = this.host.hitTest(pointer.world, HIT_PX / this.host.getCamera().zoom, this.selectable);
    const selection = new Set(this.host.getSelection());

    if (!hit) {
      this.lastDown = null;
      if (!pointer.shiftKey) selection.clear();
      this.host.setSelection(selection);
      this.state = { kind: "marquee", start: pointer.world, current: pointer.world, base: selection };
      return;
    }

    const now = performance.now();
    const doubleClick =
      this.lastDown !== null && this.lastDown.id === hit.id && now - this.lastDown.at < DOUBLE_CLICK_MS;
    this.lastDown = { id: hit.id, at: now };
    if (doubleClick && hit.type === "text" && !hit.locked) {
      this.host.beginTextEdit(hit.id, false);
      return;
    }

    if (pointer.shiftKey) {
      if (selection.has(hit.id)) selection.delete(hit.id);
      else selection.add(hit.id);
    } else if (!selection.has(hit.id)) {
      selection.clear();
      selection.add(hit.id);
    }
    this.host.setSelection(selection);
    if (!selection.has(hit.id)) return;

    const starts = new Map<string, BoardItem>();
    for (const id of selection) {
      const item = this.host.getItem(id);
      if (item && !item.locked) starts.set(id, item);
    }
    if (starts.size === 0) return;
    model.endStep();
    this.state = { kind: "move", start: pointer.world, starts, offset: { x: 0, y: 0 } };
  }

  move(pointer: BoardPointer): void {
    const state = this.state;
    if (!state) return;
    switch (state.kind) {
      case "move":
        state.offset = { x: pointer.world.x - state.start.x, y: pointer.world.y - state.start.y };
        break;
      case "marquee": {
        state.current = pointer.world;
        const touched = this.host.itemsTouching(boundsFromPoints(state.start, state.current)).filter(this.selectable);
        this.host.setSelection([...state.base, ...touched.map((item) => item.id)]);
        this.host.requestRender();
        return;
      }
      case "resize":
        state.current = this.resized(state, pointer);
        break;
      case "rotate": {
        let rotation =
          Math.atan2(pointer.world.y - state.center.y, pointer.world.x - state.center.x) + Math.PI / 2;
        if (pointer.shiftKey) rotation = Math.round(rotation / ROTATE_SNAP) * ROTATE_SNAP;
        state.current = { ...state.current, rotation: normalizeAngle(rotation) };
        break;
      }
      case "endpoint":
        state.current = this.movedEndpoint(state, pointer);
        break;
    }
    this.scheduleCommit();
    this.host.requestRender();
  }

  up(): void {
    this.finish();
  }

  hover(pointer: BoardPointer | null): void {
    if (!pointer) {
      this.hoverCursor = "default";
      return;
    }
    const handle = this.handleUnder(pointer);
    if (handle) {
      this.hoverCursor = cursorForHandle(handle.id, handle.item.rotation);
      return;
    }
    const over = this.host.hitTest(pointer.world, HIT_PX / this.host.getCamera().zoom, this.selectable);
    this.hoverCursor = over ? "move" : "default";
  }

  finish(): void {
    this.clearTimer();
    const state = this.state;
    if (state && state.kind !== "marquee") {
      this.commit();
      this.host.getEditableModel()?.endStep();
    }
    this.state = null;
    this.host.requestRender();
  }

  cancel(): void {
    this.clearTimer();
    const state = this.state;
    this.state = null;
    if (state && state.kind !== "marquee" && this.committed) {
      this.host.getEditableModel()?.discardStep();
    }
    this.committed = false;
    this.host.requestRender();
  }

  overrideItem(id: string): BoardItem | null {
    const state = this.state;
    if (!state || state.kind === "marquee") return null;
    if (state.kind === "move") {
      const start = state.starts.get(id);
      return start ? { ...start, x: start.x + state.offset.x, y: start.y + state.offset.y } : null;
    }
    return state.current.id === id ? state.current : null;
  }

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const state = this.state;
    if (state?.kind !== "marquee") return;
    const a = worldToScreen(camera, state.start);
    const b = worldToScreen(camera, state.current);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x);
    const h = Math.abs(a.y - b.y);
    ctx.save();
    ctx.fillStyle = BOARD_COLORS.selectionFill;
    ctx.strokeStyle = BOARD_COLORS.selection;
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.restore();
  }

  // ---- internals ----

  private handleUnder(pointer: BoardPointer) {
    const selection = this.host.getSelection();
    if (selection.size !== 1) return null;
    const [id] = selection;
    const item = this.host.getItem(id);
    if (!item) return null;
    const handles = handlesFor(item, this.host.geometryOf(item), this.host.getCamera());
    const radius = pointer.pointerType === "mouse" ? HANDLE_PX.mouse : HANDLE_PX.touch;
    const handle = handleAt(handles, pointer.screen, radius);
    return handle ? { id: handle.id, item } : null;
  }

  private resized(state: ResizeState, pointer: BoardPointer): BoxItem {
    const { startItem, startBox, handle } = state;
    const { hx, hy } = HANDLE_DIRECTIONS[handle];
    const corner = hx !== 0 && hy !== 0;
    if (startItem.type === "text") {
      if (corner) {
        // Corners scale the text; the sides change its wrap width.
        const box = resizeBox(startBox, handle, pointer.world, true);
        const scale = box.w / startBox.w;
        return {
          ...startItem,
          x: box.x,
          y: box.y,
          fontSize: Math.min(400, Math.max(6, Math.round(startItem.fontSize * scale * 10) / 10)),
          w: startItem.w === null ? null : startItem.w * scale,
        };
      }
      const box = resizeBox(startBox, handle, pointer.world, false);
      return { ...startItem, x: box.x, y: box.y, w: Math.max(startItem.fontSize, box.w) };
    }
    // Images keep their shape unless Shift is held; other shapes the opposite.
    const keepAspect = isPicture(startItem) ? !pointer.shiftKey : pointer.shiftKey;
    const box = resizeBox(startBox, handle, pointer.world, keepAspect);
    return { ...startItem, x: box.x, y: box.y, w: box.w, h: box.h };
  }

  private movedEndpoint(state: EndpointState, pointer: BoardPointer): LineItem {
    const item = state.current;
    const points = [...item.points];
    const index = state.end === "start" ? 0 : 2;
    const other = state.end === "start" ? 2 : 0;
    let x = pointer.world.x - item.x;
    let y = pointer.world.y - item.y;
    if (pointer.shiftKey) {
      const dx = x - points[other];
      const dy = y - points[other + 1];
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const length = Math.hypot(dx, dy);
      x = points[other] + Math.cos(angle) * length;
      y = points[other + 1] + Math.sin(angle) * length;
    }
    points[index] = x;
    points[index + 1] = y;
    return { ...item, points };
  }

  private scheduleCommit(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.commit();
    }, COMMIT_MS);
  }

  private commit(): void {
    const state = this.state;
    const model = this.host.getEditableModel();
    if (!state || state.kind === "marquee" || !model) return;
    const patches = new Map<string, ItemPatch>();
    if (state.kind === "move") {
      if (state.offset.x === 0 && state.offset.y === 0 && !this.committed) return;
      for (const [id, start] of state.starts) {
        patches.set(id, { x: start.x + state.offset.x, y: start.y + state.offset.y });
      }
    } else {
      const item = state.current;
      const patch: ItemPatch = { x: item.x, y: item.y, rotation: item.rotation };
      if (item.type === "line" || item.type === "arrow") patch.points = item.points;
      if (item.type === "rect" || item.type === "ellipse" || isPicture(item)) {
        patch.w = item.w;
        patch.h = item.h;
      }
      if (item.type === "text") {
        patch.w = item.w;
        patch.fontSize = item.fontSize;
      }
      patches.set(item.id, patch);
    }
    model.updateItems(patches);
    this.committed = true;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
