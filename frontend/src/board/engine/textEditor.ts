import type { BoardModel } from "../model/BoardModel";
import { TEXT_LINE_HEIGHT, type BoardItem, type TextItem } from "../model/schema";
import { worldToScreen, type Camera } from "./camera";
import { fontString, layoutText } from "./textLayout";

type EditorHost = {
  container: HTMLElement;
  getModel(): BoardModel | null;
  getItem(id: string): BoardItem | undefined;
  getCamera(): Camera;
  onChange(): void;
};

/**
 * Edits a text item with a real <textarea> laid exactly over it, so typing,
 * selection, IME and the on-screen keyboard all behave natively. Every
 * change is written to the board straight away, so others see the typing.
 */
export class TextEditor {
  private textarea: HTMLTextAreaElement | null = null;
  private itemId: string | null = null;
  private created = false;

  constructor(private readonly host: EditorHost) {}

  get editingId(): string | null {
    return this.itemId;
  }

  begin(id: string, created: boolean): void {
    this.end();
    const item = this.host.getItem(id);
    const model = this.host.getModel();
    if (item?.type !== "text" || !model) return;
    if (!created) model.endStep();
    this.itemId = id;
    this.created = created;

    const textarea = document.createElement("textarea");
    textarea.className = "tb-text-editor";
    textarea.value = item.text;
    textarea.spellcheck = true;
    textarea.setAttribute("aria-label", "Text");
    textarea.addEventListener("input", () => {
      this.host.getModel()?.setText(id, textarea.value);
      this.position();
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
        event.preventDefault();
        this.end();
      }
    });
    textarea.addEventListener("blur", () => this.end());
    // Keep pointer events in the editor away from the canvas.
    textarea.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.textarea = textarea;
    this.host.container.appendChild(textarea);
    this.position();
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    this.host.onChange();
  }

  /** Closes the editor. An empty text box is removed. */
  end(): void {
    const textarea = this.textarea;
    const id = this.itemId;
    if (!textarea || !id) return;
    this.textarea = null;
    this.itemId = null;
    const value = textarea.value;
    textarea.remove();
    const model = this.host.getModel();
    if (model && value.trim() === "") {
      if (this.created) model.discardStep();
      else if (this.host.getItem(id)) model.deleteItems([id]);
    }
    model?.endStep();
    this.host.onChange();
  }

  /** Lays the editor over the item. Called on every redraw. */
  position(): void {
    const textarea = this.textarea;
    const id = this.itemId;
    if (!textarea || !id) return;
    const item = this.host.getItem(id);
    if (item?.type !== "text") {
      // Deleted by someone else while being edited.
      this.end();
      return;
    }
    this.applyStyle(textarea, item);
  }

  private applyStyle(textarea: HTMLTextAreaElement, item: TextItem): void {
    const camera = this.host.getCamera();
    const zoom = camera.zoom;
    const layout = layoutText(textarea.value || " ", item.fontSize, item.fontFamily, item.w);
    const at = worldToScreen(camera, { x: item.x, y: item.y });
    // Room for the caret and the next character when the box grows with the text.
    const width = (item.w ?? layout.width + item.fontSize) * zoom;
    const style = textarea.style;
    style.left = `${at.x}px`;
    style.top = `${at.y}px`;
    style.width = `${width}px`;
    style.height = `${layout.height * zoom}px`;
    style.font = fontString(item.fontSize * zoom, item.fontFamily);
    style.lineHeight = String(TEXT_LINE_HEIGHT);
    style.color = item.stroke;
    style.textAlign = item.align;
    style.whiteSpace = item.w === null ? "pre" : "pre-wrap";
    style.transformOrigin = `${(layout.width * zoom) / 2}px ${(layout.height * zoom) / 2}px`;
    style.transform = item.rotation ? `rotate(${item.rotation}rad)` : "";
  }
}
