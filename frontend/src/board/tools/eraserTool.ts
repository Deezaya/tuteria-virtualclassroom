import type { Point } from "../engine/geometry";
import { hitItem } from "../engine/items";
import type { BoardPointer, Tool, ToolHost } from "./types";

/** Eraser radius in screen pixels, so it feels the same at any zoom. */
const RADIUS_PX = 10;

/**
 * Drag over items to mark them; they fade while marked and are removed
 * together on release, as one undo step. Locked items are skipped.
 */
export class EraserTool implements Tool {
  readonly id = "eraser" as const;
  readonly cursor = "none";
  readonly edits = true;
  private readonly marked = new Set<string>();
  private last: Point | null = null;
  private hoverAt: Point | null = null;

  constructor(private readonly host: ToolHost) {}

  down(pointer: BoardPointer): void {
    if (!this.host.getEditableModel()) return;
    this.marked.clear();
    this.last = pointer.world;
    this.hoverAt = pointer.screen;
    this.markAt(pointer.world);
    this.host.requestRender();
  }

  move(pointer: BoardPointer): void {
    this.hoverAt = pointer.screen;
    const last = this.last;
    if (last) {
      // Sample the path between events so fast swipes don't skip items.
      const step = RADIUS_PX / 2 / this.host.getCamera().zoom;
      const dx = pointer.world.x - last.x;
      const dy = pointer.world.y - last.y;
      const count = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
      for (let i = 1; i <= count; i += 1) {
        this.markAt({ x: last.x + (dx * i) / count, y: last.y + (dy * i) / count });
      }
      this.last = pointer.world;
    }
    this.host.requestRender();
  }

  up(): void {
    this.finish();
  }

  hover(pointer: BoardPointer | null): void {
    this.hoverAt = pointer?.screen ?? null;
    this.host.requestRender();
  }

  finish(): void {
    const model = this.host.getEditableModel();
    if (model && this.marked.size > 0) {
      model.endStep();
      model.deleteItems(this.marked);
      model.endStep();
    }
    this.marked.clear();
    this.last = null;
    this.host.requestRender();
  }

  cancel(): void {
    this.marked.clear();
    this.last = null;
    this.host.requestRender();
  }

  fadedIds(): ReadonlySet<string> {
    return this.marked;
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (!this.hoverAt) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.hoverAt.x, this.hoverAt.y, RADIUS_PX, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private markAt(world: Point): void {
    const radius = RADIUS_PX / this.host.getCamera().zoom;
    for (const item of this.host.getItems()) {
      if (item.locked || this.marked.has(item.id)) continue;
      if (hitItem(item, this.host.geometryOf(item), world, radius)) this.marked.add(item.id);
    }
  }
}
