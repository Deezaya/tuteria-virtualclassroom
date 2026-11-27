/**
 * A small bar above the selection with a Delete button and, for PDF pages,
 * "Remove whole PDF". It is plain DOM so the engine can move it with the
 * selection on every redraw without re-rendering React.
 */
const TRASH_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
const FILE_X_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m14.5 12.5-5 5"/><path d="m9.5 12.5 5 5"/></svg>';

export type SelectionBarState = {
  /** Selection bounds on screen, or null to hide the bar. */
  area: { x: number; y: number; w: number; h: number } | null;
  showRemovePdf: boolean;
  containerWidth: number;
};

export class SelectionBar {
  private readonly element: HTMLDivElement;
  private readonly removePdfButton: HTMLButtonElement;

  constructor(container: HTMLElement, handlers: { onDelete(): void; onRemovePdf(): void }) {
    const element = document.createElement("div");
    element.className = "tb-selection-bar";
    element.setAttribute("role", "toolbar");
    element.setAttribute("aria-label", "Selection");
    element.hidden = true;

    const make = (label: string, icon: string, onClick: () => void) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tb-selection-button";
      button.title = label;
      button.setAttribute("aria-label", label);
      button.innerHTML = `${icon}<span>${label}</span>`;
      // Keep focus on the board so keyboard shortcuts keep working.
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", onClick);
      element.appendChild(button);
      return button;
    };
    make("Delete", TRASH_ICON, handlers.onDelete);
    this.removePdfButton = make("Remove whole PDF", FILE_X_ICON, handlers.onRemovePdf);
    container.appendChild(element);
    this.element = element;
  }

  update(state: SelectionBarState): void {
    const { element } = this;
    if (!state.area) {
      element.hidden = true;
      return;
    }
    this.removePdfButton.hidden = !state.showRemovePdf;
    element.hidden = false;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const { x, y, w, h } = state.area;
    const left = Math.max(8, Math.min(x + w / 2 - width / 2, state.containerWidth - width - 8));
    // Above the selection when there is room, otherwise below it.
    const top = y - height - 12 >= 8 ? y - height - 12 : y + h + 12;
    element.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  destroy(): void {
    this.element.remove();
  }
}
