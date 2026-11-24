import { BOARD_FONT, TEXT_LINE_HEIGHT } from "../model/schema";
import type { BoardPointer, Tool, ToolHost } from "./types";

/** Click to start typing; click an existing text box to edit it. */
export class TextTool implements Tool {
  readonly id = "text" as const;
  readonly cursor = "text";
  readonly edits = true;

  constructor(private readonly host: ToolHost) {}

  down(pointer: BoardPointer): void {
    const model = this.host.getEditableModel();
    if (!model) return;
    const hit = this.host.hitTest(pointer.world, 4 / this.host.getCamera().zoom);
    if (hit?.type === "text" && !hit.locked) {
      this.host.beginTextEdit(hit.id, false);
      return;
    }
    const style = this.host.getStyle();
    const id = crypto.randomUUID();
    model.endStep();
    model.createItem({
      id,
      type: "text",
      // Centre the first line on the click.
      x: pointer.world.x,
      y: pointer.world.y - (style.fontSize * TEXT_LINE_HEIGHT) / 2,
      rotation: 0,
      stroke: style.stroke,
      fill: null,
      strokeWidth: 0,
      opacity: 1,
      locked: false,
      text: "",
      fontSize: style.fontSize,
      fontFamily: BOARD_FONT,
      align: "left",
      w: null,
    });
    this.host.beginTextEdit(id, true);
  }

  move(): void {}
  up(): void {}
  cancel(): void {}
  finish(): void {}
}
