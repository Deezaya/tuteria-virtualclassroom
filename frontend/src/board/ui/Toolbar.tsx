import { Ban, Eye, Maximize, Navigation, Search, SlidersHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { EngineSnapshot, StylePatch } from "../engine/BoardEngine";
import type { BoardConnectionStatus } from "../sync/useBoardConnection";
import type { ToolId } from "../tools/types";
import {
  COLOR_NAMES,
  FILL_COLORS,
  HIGHLIGHTER_WIDTHS,
  LINE_COLORS,
  LINE_WIDTHS,
  TEXT_SIZES,
  TOOLBAR,
  type ToolbarEntry,
} from "./toolbarConfig";

type PanelId = "style" | "shapes" | "zoom" | "size";

type ToolbarProps = {
  snapshot: EngineSnapshot;
  /** The person's permission, before the board's own checks. */
  canEdit: boolean;
  connection: BoardConnectionStatus;
  /** The board element; panels are positioned inside it. */
  rootRef: RefObject<HTMLDivElement | null>;
  onTool(id: ToolId): void;
  onStyle(patch: StylePatch): void;
  onUndo(): void;
  onRedo(): void;
  /** Opens the "Add to board" dialog. */
  onAdd(): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
  onZoomFit(): void;
  /** Leading Mode is following someone: shown as a label. */
  followingName?: string | null;
};

/** Keeps focus where it is (e.g. in a text box being typed in). */
const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

function entryEdits(entry: ToolbarEntry): boolean {
  if (entry.kind === "tool") return entry.edits;
  return entry.kind !== "zoom";
}

function colorName(color: string | null): string {
  if (color === null) return "No fill";
  return COLOR_NAMES[color] ?? color;
}

export function Toolbar(props: ToolbarProps) {
  const { snapshot, canEdit, connection, rootRef } = props;
  const [open, setOpen] = useState<{ id: PanelId; left: number; top: number } | null>(null);
  const anchors = useRef(new Map<PanelId, HTMLButtonElement>());
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if ([...anchors.current.values()].some((anchor) => anchor.contains(target))) return;
      setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    const onResize = () => setOpen(null);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Close panels that no longer apply, e.g. after editing is turned off.
  useEffect(() => {
    if (!snapshot.editable && open && open.id !== "zoom") setOpen(null);
    if (snapshot.following && open?.id === "zoom") setOpen(null);
  }, [snapshot.editable, snapshot.following, open]);

  function toggle(id: PanelId) {
    if (open?.id === id) {
      setOpen(null);
      return;
    }
    const anchor = anchors.current.get(id);
    const root = rootRef.current;
    if (!anchor || !root) return;
    const a = anchor.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    const panelWidth = id === "style" ? 290 : 220;
    const left = Math.max(8, Math.min(a.left - r.left, r.width - panelWidth - 8));
    setOpen({ id, left, top: a.bottom - r.top + 8 });
  }

  const anchorRef = (id: PanelId) => (element: HTMLButtonElement | null) => {
    if (element) anchors.current.set(id, element);
    else anchors.current.delete(id);
  };

  const groups = TOOLBAR.map((group) => group.filter((entry) => canEdit || !entryEdits(entry))).filter(
    (group) => group.length > 0,
  );
  const following = snapshot.following;
  const highlighter = snapshot.tool === "highlighter";
  const shapesEntry = TOOLBAR.flat().find((entry) => entry.kind === "shapes");
  const activeShape =
    shapesEntry?.kind === "shapes" ? shapesEntry.tools.find((tool) => tool.id === snapshot.tool) : undefined;

  function renderEntry(entry: ToolbarEntry, key: string): ReactNode {
    switch (entry.kind) {
      case "style":
        return (
          <button
            aria-expanded={open?.id === "style"}
            aria-label={`Colour: ${colorName(snapshot.strokeColor)}`}
            className={`tb-button tb-color-button${open?.id === "style" ? " is-active" : ""}`}
            disabled={!snapshot.editable}
            key={key}
            onClick={() => toggle("style")}
            ref={anchorRef("style")}
            title="Colour"
            type="button"
          >
            <span className="tb-color-ring" style={{ borderColor: snapshot.strokeColor }} />
          </button>
        );
      case "tool": {
        const Icon = entry.icon;
        const active = snapshot.tool === entry.id;
        return (
          <button
            aria-label={entry.label}
            aria-pressed={active}
            className={`tb-button${active ? " is-active" : ""}`}
            disabled={entry.edits ? !snapshot.editable : following}
            key={key}
            onClick={() => props.onTool(entry.id)}
            title={`${entry.label} (${entry.shortcut})`}
            type="button"
          >
            <Icon aria-hidden="true" size={19} />
          </button>
        );
      }
      case "shapes": {
        const Icon = activeShape?.icon ?? entry.icon;
        return (
          <button
            aria-expanded={open?.id === "shapes"}
            aria-label={entry.label}
            aria-pressed={activeShape !== undefined}
            className={`tb-button${activeShape || open?.id === "shapes" ? " is-active" : ""}`}
            disabled={!snapshot.editable}
            key={key}
            onClick={() => toggle("shapes")}
            ref={anchorRef("shapes")}
            title={entry.label}
            type="button"
          >
            <Icon aria-hidden="true" size={19} />
          </button>
        );
      }
      case "action": {
        const Icon = entry.icon;
        const canAdd = snapshot.canUpload || snapshot.canAddPdf;
        const disabled =
          entry.id === "undo" ? !snapshot.canUndo : entry.id === "redo" ? !snapshot.canRedo : !canAdd;
        const onClick =
          entry.id === "undo" ? props.onUndo : entry.id === "redo" ? props.onRedo : props.onAdd;
        // No upload permission at all: hide the button rather than show it disabled.
        if (entry.id === "upload" && !canAdd && snapshot.editable) return null;
        return (
          <button
            aria-label={entry.label}
            className="tb-button"
            disabled={disabled}
            key={key}
            onClick={onClick}
            title={entry.shortcut ? `${entry.label} (${entry.shortcut})` : entry.label}
            type="button"
          >
            <Icon aria-hidden="true" size={19} />
          </button>
        );
      }
      case "zoom":
        return (
          <button
            aria-expanded={open?.id === "zoom"}
            aria-label={`Zoom ${Math.round(snapshot.zoom * 100)}%`}
            className={`tb-button tb-zoom${open?.id === "zoom" ? " is-active" : ""}`}
            disabled={following}
            key={key}
            onClick={() => toggle("zoom")}
            ref={anchorRef("zoom")}
            title="Zoom"
            type="button"
          >
            <Search aria-hidden="true" size={17} />
            <span>{Math.round(snapshot.zoom * 100)}%</span>
          </button>
        );
      case "size":
        return (
          <button
            aria-expanded={open?.id === "size"}
            aria-label="Line width and text size"
            className={`tb-button${open?.id === "size" ? " is-active" : ""}`}
            disabled={!snapshot.editable}
            key={key}
            onClick={() => toggle("size")}
            ref={anchorRef("size")}
            title="Line width and text size"
            type="button"
          >
            <SlidersHorizontal aria-hidden="true" size={19} />
          </button>
        );
    }
  }

  function renderPanel(id: PanelId): ReactNode {
    if (id === "style") {
      return (
        <>
          <p className="tb-panel-label">Line colour</p>
          <div className="tb-swatches">
            {LINE_COLORS.map((color) => (
              <button
                aria-label={colorName(color)}
                aria-pressed={snapshot.strokeColor === color}
                className={`tb-swatch is-ring${snapshot.strokeColor === color ? " is-selected" : ""}`}
                key={color}
                onClick={() => props.onStyle({ stroke: color })}
                style={{ borderColor: color }}
                title={colorName(color)}
                type="button"
              />
            ))}
          </div>
          {!highlighter && (
            <>
              <p className="tb-panel-label">Fill colour</p>
              <div className="tb-swatches">
                {FILL_COLORS.map((color) => (
                  <button
                    aria-label={colorName(color)}
                    aria-pressed={snapshot.fillColor === color}
                    className={`tb-swatch${color === null ? " is-none" : ""}${snapshot.fillColor === color ? " is-selected" : ""}`}
                    key={color ?? "none"}
                    onClick={() => props.onStyle({ fill: color })}
                    style={color ? { background: color } : undefined}
                    title={colorName(color)}
                    type="button"
                  >
                    {color === null && <Ban aria-hidden="true" size={20} />}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      );
    }
    if (id === "shapes" && shapesEntry?.kind === "shapes") {
      return (
        <div className="tb-menu">
          {shapesEntry.tools.map(({ id: toolId, label, shortcut, icon: Icon }) => (
            <button
              aria-pressed={snapshot.tool === toolId}
              className={`tb-menu-item${snapshot.tool === toolId ? " is-active" : ""}`}
              key={toolId}
              onClick={() => {
                props.onTool(toolId);
                setOpen(null);
              }}
              type="button"
            >
              <Icon aria-hidden="true" size={18} />
              <span>{label}</span>
              <kbd>{shortcut}</kbd>
            </button>
          ))}
        </div>
      );
    }
    if (id === "zoom") {
      return (
        <div className="tb-menu">
          <button className="tb-menu-item" onClick={props.onZoomIn} type="button">
            <ZoomIn aria-hidden="true" size={18} />
            <span>Zoom in</span>
            <kbd>Ctrl +</kbd>
          </button>
          <button className="tb-menu-item" onClick={props.onZoomOut} type="button">
            <ZoomOut aria-hidden="true" size={18} />
            <span>Zoom out</span>
            <kbd>Ctrl −</kbd>
          </button>
          <button className="tb-menu-item" onClick={props.onZoomReset} type="button">
            <Search aria-hidden="true" size={18} />
            <span>Zoom to 100%</span>
            <kbd>Ctrl 0</kbd>
          </button>
          <button
            className="tb-menu-item"
            onClick={() => {
              props.onZoomFit();
              setOpen(null);
            }}
            type="button"
          >
            <Maximize aria-hidden="true" size={18} />
            <span>Show everything</span>
          </button>
        </div>
      );
    }
    if (id === "size") {
      const widths = highlighter ? HIGHLIGHTER_WIDTHS : LINE_WIDTHS;
      return (
        <>
          <p className="tb-panel-label">Line width</p>
          <div className="tb-options">
            {widths.map((width, index) => (
              <button
                aria-label={`Line width ${index + 1}`}
                aria-pressed={snapshot.strokeWidth === width}
                className={`tb-option${snapshot.strokeWidth === width ? " is-selected" : ""}`}
                key={width}
                onClick={() => props.onStyle({ strokeWidth: width })}
                type="button"
              >
                <span
                  className="tb-width-sample"
                  style={{ height: Math.max(2, Math.min(16, (width / widths[widths.length - 1]) * 16)) }}
                />
              </button>
            ))}
          </div>
          {!highlighter && (
            <>
              <p className="tb-panel-label">Text size</p>
              <div className="tb-options">
                {TEXT_SIZES.map(({ label, size }) => (
                  <button
                    aria-label={`Text size ${label}`}
                    aria-pressed={snapshot.fontSize === size}
                    className={`tb-option${snapshot.fontSize === size ? " is-selected" : ""}`}
                    key={size}
                    onClick={() => props.onStyle({ fontSize: size })}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      );
    }
    return null;
  }

  return (
    <>
      <div aria-label="Whiteboard tools" className="tb-toolbar" onMouseDown={keepFocus} role="toolbar">
        {groups.map((group, index) => (
          <div className="tb-group" key={index}>
            {group.map((entry, entryIndex) => renderEntry(entry, `${index}-${entryIndex}`))}
          </div>
        ))}

        <div className="tb-spacer" />

        {props.followingName && (
          <span className="tb-chip is-following">
            <Navigation aria-hidden="true" size={14} />
            Following {props.followingName}
          </span>
        )}
        {!canEdit && (
          <span className="tb-chip">
            <Eye aria-hidden="true" size={14} />
            View only
          </span>
        )}
        {connection !== "Connected" && (
          <span
            aria-live="polite"
            className={`tb-chip ${connection === "Offline" ? "is-offline" : "is-reconnecting"}`}
          >
            {connection}
          </span>
        )}
      </div>
      {open && (
        <div
          className={`tb-panel tb-panel-${open.id}`}
          onMouseDown={keepFocus}
          ref={panelRef}
          role="dialog"
          aria-label={open.id === "style" ? "Colours" : open.id === "size" ? "Sizes" : open.id === "zoom" ? "Zoom" : "Shapes"}
          style={{ left: open.left, top: open.top }}
        >
          {renderPanel(open.id)}
        </div>
      )}
    </>
  );
}
