import { panBy } from "../engine/camera";
import type { Point } from "../engine/geometry";
import type { BoardPointer, Tool, ToolHost } from "./types";

/** Drags the view. Also used by the engine for middle-drag and Space-drag. */
export class HandTool implements Tool {
  readonly id = "hand" as const;
  readonly edits = false;
  private last: Point | null = null;

  constructor(private readonly host: ToolHost) {}

  get cursor(): string {
    return this.last ? "grabbing" : "grab";
  }

  down(pointer: BoardPointer): void {
    this.last = pointer.screen;
  }

  move(pointer: BoardPointer): void {
    if (!this.last) return;
    const dx = pointer.screen.x - this.last.x;
    const dy = pointer.screen.y - this.last.y;
    this.last = pointer.screen;
    this.host.setCamera(panBy(this.host.getCamera(), dx, dy));
  }

  up(): void {
    this.last = null;
  }

  cancel(): void {
    this.last = null;
  }

  finish(): void {
    this.last = null;
  }
}
