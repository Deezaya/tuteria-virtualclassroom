import type { Point } from "../engine/geometry";
import type { ItemPatch, NewItem } from "../model/BoardModel";
import type { BoardItem } from "../model/schema";
import type { BoardPointer, ShapeKind, Tool, ToolHost } from "./types";

/** How often a shape being drawn is written, so others see it grow. */
const FLUSH_MS = 50;
/** Drags shorter than this (screen pixels) don't create a shape. */
const MIN_DRAG_PX = 3;

type Draft = { item: NewItem; createdAt: number; created: boolean };

/** Rectangle, ellipse, line and arrow: drag from one corner (or end) to the other. */
export class ShapeTool implements Tool {
  readonly cursor = "crosshair";
  readonly edits = true;
  private start: Point | null = null;
  private draft: Draft | null = null;
  private timer: number | null = null;
  private readonly hidden = new Set<string>();

  constructor(
    private readonly host: ToolHost,
    readonly id: ShapeKind,
  ) {}

  down(pointer: BoardPointer): void {
    const model = this.host.getEditableModel();
    if (!model) return;
    model.endStep();
    this.start = pointer.world;
    this.draft = null;
  }

  move(pointer: BoardPointer): void {
    const start = this.start;
    if (!start) return;
    const zoom = this.host.getCamera().zoom;
    if (!this.draft && Math.hypot(pointer.world.x - start.x, pointer.world.y - start.y) * zoom < MIN_DRAG_PX) {
      return;
    }
    const item = this.buildItem(start, pointer.world, pointer.shiftKey);
    if (!this.draft) {
      this.draft = { item, createdAt: Date.now(), created: false };
      this.hidden.clear();
      this.hidden.add(item.id);
    } else {
      this.draft.item = item;
    }
    if (this.timer === null) {
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.flush();
      }, FLUSH_MS);
    }
    this.host.requestRender();
  }

  up(pointer: BoardPointer): void {
    if (this.draft) this.move(pointer);
    this.finish();
  }

  finish(): void {
    this.clearTimer();
    this.flush();
    this.start = null;
    this.draft = null;
    this.hidden.clear();
    this.host.getEditableModel()?.endStep();
    this.host.requestRender();
  }

  cancel(): void {
    this.clearTimer();
    const created = this.draft?.created ?? false;
    this.start = null;
    this.draft = null;
    this.hidden.clear();
    if (created) this.host.getEditableModel()?.discardStep();
    this.host.requestRender();
  }

  hiddenIds(): ReadonlySet<string> {
    return this.hidden;
  }

  previewItems(): readonly BoardItem[] {
    const draft = this.draft;
    if (!draft) return [];
    return [{ ...draft.item, z: "", createdBy: "", createdAt: draft.createdAt } as BoardItem];
  }

  private flush(): void {
    const draft = this.draft;
    const model = this.host.getEditableModel();
    if (!draft || !model) return;
    if (!draft.created) {
      model.createItem(draft.item);
      draft.created = true;
      return;
    }
    // The model ignores id and type in a patch.
    model.updateItem(draft.item.id, draft.item as unknown as ItemPatch);
  }

  private buildItem(start: Point, end: Point, constrain: boolean): NewItem {
    const style = this.host.getStyle();
    const id = this.draft?.item.id ?? crypto.randomUUID();
    const base = {
      id,
      rotation: 0,
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      opacity: 1,
      locked: false,
    };
    let dx = end.x - start.x;
    let dy = end.y - start.y;

    if (this.id === "line" || this.id === "arrow") {
      if (constrain) {
        // Snap to the nearest 45°.
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const length = Math.hypot(dx, dy);
        dx = Math.cos(angle) * length;
        dy = Math.sin(angle) * length;
      }
      return {
        ...base,
        type: this.id,
        x: start.x,
        y: start.y,
        fill: null,
        points: [0, 0, dx, dy],
        arrowStart: false,
        arrowEnd: this.id === "arrow",
      };
    }

    if (constrain) {
      // Square or circle.
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * size;
      dy = Math.sign(dy || 1) * size;
    }
    return {
      ...base,
      type: this.id,
      x: Math.min(start.x, start.x + dx),
      y: Math.min(start.y, start.y + dy),
      w: Math.abs(dx),
      h: Math.abs(dy),
      fill: style.fill,
    };
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
