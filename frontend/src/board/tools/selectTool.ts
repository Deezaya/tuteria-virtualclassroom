import { boundsFromPoints, type Point } from "../engine/geometry";
import { worldToScreen, type Camera } from "../engine/camera";
import { BOARD_COLORS } from "../engine/renderer";
import type { BoardPointer, Tool, ToolHost } from "./types";

/** How often a move in progress is written, so others see it live. */
const MOVE_COMMIT_MS = 50;
/** Click tolerance around thin strokes, in screen pixels. */
const HIT_PX = 6;

type MoveState = {
  kind: "move";
  start: Point;
  starts: Map<string, Point>;
  offset: Point;
  committed: boolean;
};

type MarqueeState = {
  kind: "marquee";
  start: Point;
  current: Point;
  base: Set<string>;
};

/** Click or drag a box to select; drag a selection to move it. */
export class SelectTool implements Tool {
  readonly id = "select" as const;
  readonly edits = true;
  private state: MoveState | MarqueeState | null = null;
  private overItem = false;
  private timer: number | null = null;

  constructor(private readonly host: ToolHost) {}

  get cursor(): string {
    if (this.state?.kind === "move") return "grabbing";
    return this.overItem ? "move" : "default";
  }

  down(pointer: BoardPointer): void {
    const model = this.host.getEditableModel();
    if (!model) return;
    const hit = this.host.hitTest(pointer.world, HIT_PX / this.host.getCamera().zoom);
    const selection = new Set(this.host.getSelection());

    if (!hit) {
      if (!pointer.shiftKey) selection.clear();
      this.host.setSelection(selection);
      this.state = {
        kind: "marquee",
        start: pointer.world,
        current: pointer.world,
        base: selection,
      };
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

    const starts = new Map<string, Point>();
    for (const item of this.host.getItems()) {
      if (selection.has(item.id) && !item.locked) starts.set(item.id, { x: item.x, y: item.y });
    }
    if (starts.size === 0) return;
    model.endStep();
    this.state = { kind: "move", start: pointer.world, starts, offset: { x: 0, y: 0 }, committed: false };
  }

  move(pointer: BoardPointer): void {
    const state = this.state;
    if (!state) return;
    if (state.kind === "move") {
      state.offset = { x: pointer.world.x - state.start.x, y: pointer.world.y - state.start.y };
      if (this.timer === null) {
        this.timer = window.setTimeout(() => {
          this.timer = null;
          this.commitMove();
        }, MOVE_COMMIT_MS);
      }
    } else {
      state.current = pointer.world;
      const touched = this.host.itemsTouching(boundsFromPoints(state.start, state.current));
      this.host.setSelection([...state.base, ...touched.map((item) => item.id)]);
    }
    this.host.requestRender();
  }

  up(): void {
    this.finish();
  }

  hover(pointer: BoardPointer | null): void {
    const over =
      pointer !== null &&
      this.host.hitTest(pointer.world, HIT_PX / this.host.getCamera().zoom) !== null;
    this.overItem = over;
  }

  finish(): void {
    this.clearTimer();
    if (this.state?.kind === "move") {
      this.commitMove();
      this.host.getEditableModel()?.endStep();
    }
    this.state = null;
    this.host.requestRender();
  }

  cancel(): void {
    this.clearTimer();
    const state = this.state;
    this.state = null;
    if (state?.kind === "move" && state.committed) {
      this.host.getEditableModel()?.discardStep();
    }
    this.host.requestRender();
  }

  positionOverride(id: string): Point | null {
    const state = this.state;
    if (state?.kind !== "move") return null;
    const start = state.starts.get(id);
    return start ? { x: start.x + state.offset.x, y: start.y + state.offset.y } : null;
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

  private commitMove(): void {
    const state = this.state;
    const model = this.host.getEditableModel();
    if (state?.kind !== "move" || !model) return;
    if (state.offset.x === 0 && state.offset.y === 0 && !state.committed) return;
    const positions = new Map<string, Point>();
    for (const [id, start] of state.starts) {
      positions.set(id, { x: start.x + state.offset.x, y: start.y + state.offset.y });
    }
    model.moveItems(positions);
    state.committed = true;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
