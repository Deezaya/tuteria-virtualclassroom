import type { Point } from "../engine/geometry";
import type { StrokeItem, StrokeTool } from "../model/schema";
import type { BoardPointer, PointerSample, Tool, ToolHost } from "./types";

/** How often new points are sent while drawing. */
const FLUSH_MS = 32;
/**
 * A touch stroke is held back this long before it is written, so a second
 * finger landing (pinch or pan) can cancel it without leaving a mark.
 */
const TOUCH_HOLD_MS = 60;
/** Points closer than this many screen pixels to the last one are skipped. */
const MIN_STEP_PX = 0.75;
/** Stored for every point when the device gives no real pressure. */
const NO_PRESSURE = 0.5;
const HIGHLIGHTER_OPACITY = 0.45;

type ActiveStroke = {
  id: string;
  origin: Point;
  /** Flat [x, y, pressure, …] relative to origin. */
  points: number[];
  /** How many numbers have been written to the board. */
  sent: number;
  created: boolean;
  startedAt: number;
  pointerType: string;
  stroke: string;
  strokeWidth: number;
  createdAt: number;
};

const round = (value: number) => Math.round(value * 100) / 100;

/** Pen and highlighter: the same tool with a different look. */
export class PenTool implements Tool {
  readonly id: "pen" | "highlighter";
  readonly cursor = "crosshair";
  readonly edits = true;
  private readonly kind: StrokeTool;
  private active: ActiveStroke | null = null;
  private timer: number | null = null;
  private readonly hidden = new Set<string>();

  constructor(
    private readonly host: ToolHost,
    kind: StrokeTool,
  ) {
    this.kind = kind;
    this.id = kind;
  }

  down(pointer: BoardPointer): void {
    const model = this.host.getEditableModel();
    if (!model || this.active) return;
    model.endStep();
    const style = this.host.getStyle();
    const highlighter = this.kind === "highlighter";
    this.active = {
      id: crypto.randomUUID(),
      origin: pointer.world,
      points: [],
      sent: 0,
      created: false,
      startedAt: performance.now(),
      pointerType: pointer.pointerType,
      stroke: highlighter ? style.highlighter : style.stroke,
      strokeWidth: highlighter ? style.highlighterWidth : style.strokeWidth,
      createdAt: Date.now(),
    };
    this.hidden.clear();
    this.hidden.add(this.active.id);
    this.addPoint({ world: pointer.world, pressure: pointer.pressure });
    this.scheduleFlush();
    this.host.requestRender();
  }

  move(pointer: BoardPointer): void {
    if (!this.active) return;
    for (const sample of pointer.samples) this.addPoint(sample);
    this.scheduleFlush();
    this.host.requestRender();
  }

  up(pointer: BoardPointer): void {
    if (!this.active) return;
    this.addPoint({ world: pointer.world, pressure: pointer.pressure });
    this.finish();
  }

  finish(): void {
    if (!this.active) return;
    this.clearTimer();
    this.flush(true);
    this.active = null;
    this.hidden.clear();
    this.host.getEditableModel()?.endStep();
    this.host.requestRender();
  }

  cancel(): void {
    const active = this.active;
    if (!active) return;
    this.clearTimer();
    this.active = null;
    this.hidden.clear();
    if (active.created) this.host.getEditableModel()?.discardStep();
    this.host.requestRender();
  }

  hiddenIds(): ReadonlySet<string> {
    return this.hidden;
  }

  previewItems(): readonly StrokeItem[] {
    const active = this.active;
    if (!active) return [];
    return [
      {
        id: active.id,
        type: "stroke",
        x: active.origin.x,
        y: active.origin.y,
        rotation: 0,
        z: "",
        createdBy: "",
        createdAt: active.createdAt,
        stroke: active.stroke,
        fill: null,
        strokeWidth: active.strokeWidth,
        opacity: this.kind === "highlighter" ? HIGHLIGHTER_OPACITY : 1,
        locked: false,
        tab: "",
        tool: this.kind,
        points: active.points,
        done: false,
      },
    ];
  }

  private addPoint(sample: PointerSample): void {
    const active = this.active;
    if (!active) return;
    const x = round(sample.world.x - active.origin.x);
    const y = round(sample.world.y - active.origin.y);
    const { points } = active;
    if (points.length >= 3) {
      const dx = x - points[points.length - 3];
      const dy = y - points[points.length - 2];
      const min = MIN_STEP_PX / this.host.getCamera().zoom;
      if (dx * dx + dy * dy < min * min) return;
    }
    // Only styluses report real pressure; mice and fingers give fixed values.
    const pressure =
      this.kind === "pen" && active.pointerType === "pen" && sample.pressure > 0
        ? round(sample.pressure)
        : NO_PRESSURE;
    points.push(x, y, pressure);
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flush(false);
    }, FLUSH_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private flush(done: boolean): void {
    const active = this.active;
    const model = this.host.getEditableModel();
    if (!active || !model) return;
    if (!active.created) {
      const held =
        active.pointerType === "touch" && performance.now() - active.startedAt < TOUCH_HOLD_MS;
      if (held && !done) {
        this.scheduleFlush();
        return;
      }
      model.createItem({
        id: active.id,
        type: "stroke",
        x: active.origin.x,
        y: active.origin.y,
        rotation: 0,
        stroke: active.stroke,
        fill: null,
        strokeWidth: active.strokeWidth,
        opacity: this.kind === "highlighter" ? HIGHLIGHTER_OPACITY : 1,
        locked: false,
        tool: this.kind,
        points: active.points.slice(),
        done,
      });
      active.created = true;
      active.sent = active.points.length;
      return;
    }
    model.appendStrokePoints(active.id, active.points.slice(active.sent), done);
    active.sent = active.points.length;
  }
}
