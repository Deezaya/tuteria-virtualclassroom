import { Eye, Redo2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import type { EngineSnapshot } from "../engine/BoardEngine";
import type { BoardConnectionStatus } from "../sync/useBoardConnection";
import type { ToolId } from "../tools/types";
import { TOOL_GROUPS } from "./toolbarConfig";

type ToolbarProps = {
  snapshot: EngineSnapshot;
  /** The person's permission, before the board's own checks. */
  canEdit: boolean;
  connection: BoardConnectionStatus;
  onTool(id: ToolId): void;
  onUndo(): void;
  onRedo(): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
};

export function Toolbar({
  snapshot,
  canEdit,
  connection,
  onTool,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: ToolbarProps) {
  const groups = TOOL_GROUPS.map((group) =>
    group.filter((tool) => canEdit || !tool.edits),
  ).filter((group) => group.length > 0);

  return (
    <div aria-label="Whiteboard tools" className="tb-toolbar" role="toolbar">
      {groups.map((group, index) => (
        <div className="tb-group" key={index}>
          {group.map(({ id, label, shortcut, icon: Icon, edits }) => (
            <button
              aria-label={label}
              aria-pressed={snapshot.tool === id}
              className={`tb-button${snapshot.tool === id ? " is-active" : ""}`}
              disabled={edits && !snapshot.editable}
              key={id}
              onClick={() => onTool(id)}
              title={`${label} (${shortcut})`}
              type="button"
            >
              <Icon aria-hidden="true" size={18} />
            </button>
          ))}
        </div>
      ))}

      {canEdit && (
        <div className="tb-group">
          <button
            aria-label="Undo"
            className="tb-button"
            disabled={!snapshot.canUndo}
            onClick={onUndo}
            title="Undo (Ctrl+Z)"
            type="button"
          >
            <Undo2 aria-hidden="true" size={18} />
          </button>
          <button
            aria-label="Redo"
            className="tb-button"
            disabled={!snapshot.canRedo}
            onClick={onRedo}
            title="Redo (Ctrl+Shift+Z)"
            type="button"
          >
            <Redo2 aria-hidden="true" size={18} />
          </button>
        </div>
      )}

      <div className="tb-group">
        <button aria-label="Zoom out" className="tb-button" onClick={onZoomOut} title="Zoom out (Ctrl+-)" type="button">
          <ZoomOut aria-hidden="true" size={18} />
        </button>
        <button
          aria-label="Reset zoom to 100%"
          className="tb-button tb-zoom"
          onClick={onZoomReset}
          title="Reset zoom (Ctrl+0)"
          type="button"
        >
          {Math.round(snapshot.zoom * 100)}%
        </button>
        <button aria-label="Zoom in" className="tb-button" onClick={onZoomIn} title="Zoom in (Ctrl++)" type="button">
          <ZoomIn aria-hidden="true" size={18} />
        </button>
      </div>

      <div className="tb-spacer" />

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
  );
}
