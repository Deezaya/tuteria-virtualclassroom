import { worldToScreen, type Camera } from "../engine/camera";
import type { Point } from "../engine/geometry";
import { BOARD_COLORS, drawLaser } from "../engine/renderer";
import type { BoardPointer, Tool, ToolHost } from "./types";

/** How long a point stays in the trail. */
export const LASER_TRAIL_MS = 700;

type TrailPoint = Point & { t: number };

/**
 * A fading red trail everyone in the room sees. It travels through
 * awareness only and is never saved to the board.
 */
export class LaserTool implements Tool {
  readonly id = "laser" as const;
  readonly cursor = "none";
  readonly edits = true;
  private trail: TrailPoint[] = [];
  private drawing = false;
  private hoverAt: Point | null = null;

  constructor(private readonly host: ToolHost) {}

  down(pointer: BoardPointer): void {
    this.drawing = true;
    this.hoverAt = pointer.world;
    this.add(pointer.world);
  }

  move(pointer: BoardPointer): void {
    this.hoverAt = pointer.world;
    if (this.drawing) for (const sample of pointer.samples) this.add(sample.world);
    this.host.requestRender();
  }

  up(): void {
    this.stop();
  }

  hover(pointer: BoardPointer | null): void {
    this.hoverAt = pointer?.world ?? null;
    this.host.requestRender();
  }

  cancel(): void {
    this.stop();
  }

  finish(): void {
    this.stop();
  }

  isAnimating(): boolean {
    return this.trail.length > 0;
  }

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    this.prune();
    if (this.trail.length > 1) {
      drawLaser(ctx, camera, { points: this.trail, color: BOARD_COLORS.laser, alpha: 1 });
    }
    if (this.hoverAt && !this.drawing) {
      const at = worldToScreen(camera, this.hoverAt);
      ctx.save();
      ctx.fillStyle = BOARD_COLORS.laser;
      ctx.shadowColor = BOARD_COLORS.laser;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(at.x, at.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private add(point: Point): void {
    this.trail.push({ ...point, t: performance.now() });
    this.prune();
    this.host.publishLaser(this.trail.map(({ x, y }) => ({ x, y })));
    this.host.requestRender();
  }

  private prune(): void {
    const cutoff = performance.now() - LASER_TRAIL_MS;
    let drop = 0;
    while (drop < this.trail.length && this.trail[drop].t < cutoff) drop += 1;
    if (drop > 0) this.trail = this.trail.slice(drop);
  }

  private stop(): void {
    if (!this.drawing) return;
    this.drawing = false;
    this.host.publishLaser(null);
    this.host.requestRender();
  }
}
