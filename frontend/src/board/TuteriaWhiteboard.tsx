import type { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BoardEngine, type EngineSnapshot } from "./engine/BoardEngine";
import type { Point } from "./engine/geometry";
import type { RemoteCursor } from "./engine/renderer";
import { BoardModel } from "./model/BoardModel";
import { useBoardConnection } from "./sync/useBoardConnection";
import type { BoardProps } from "./types";
import { Toolbar } from "./ui/Toolbar";
import "./board.css";

/** How often this person's cursor position is shared. */
const CURSOR_SEND_MS = 100;
const CURSOR_COLORS = [
  "#e03131",
  "#2f9e44",
  "#1971c2",
  "#f08c00",
  "#9c36b5",
  "#0c8599",
  "#c2255c",
  "#5c940d",
];

const INITIAL_SNAPSHOT: EngineSnapshot = {
  tool: "hand",
  editable: false,
  canUndo: false,
  canRedo: false,
  zoom: 1,
  selectionCount: 0,
  schema: null,
};
const noSubscribe = () => () => undefined;
const initialSnapshot = () => INITIAL_SNAPSHOT;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRemoteCursors(ownClientId: number, provider: HocuspocusProvider): RemoteCursor[] {
  const cursors: RemoteCursor[] = [];
  const states = provider.awareness?.getStates();
  if (!states) return cursors;
  for (const [clientId, state] of states) {
    if (clientId === ownClientId || !isRecord(state)) continue;
    const { user, cursor } = state;
    if (!isRecord(user) || !isRecord(cursor) || user.role === "observer") continue;
    if (typeof user.name !== "string" || typeof cursor.x !== "number" || typeof cursor.y !== "number") {
      continue;
    }
    cursors.push({
      clientId,
      name: user.name,
      color: CURSOR_COLORS[clientId % CURSOR_COLORS.length],
      x: cursor.x,
      y: cursor.y,
    });
  }
  return cursors;
}

/** The custom whiteboard. Loaded only when VITE_BOARD_ENGINE=tuteria. */
export default function TuteriaWhiteboard({
  canEdit,
  classRole,
  displayName,
  sessionId,
  roomId,
  spyMode,
}: BoardProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<BoardEngine | null>(null);
  const modelRef = useRef<BoardModel | null>(null);
  const [engine, setEngine] = useState<BoardEngine | null>(null);
  const editable = canEdit && !spyMode;
  const editableRef = useRef(editable);
  editableRef.current = editable;

  const { connection, error, loading, providerRef, retry } = useBoardConnection(
    { classRole, displayName, roomId, sessionId, spyMode },
    ({ getProvider }) => {
      let model: BoardModel | null = null;

      function syncCursors() {
        const provider = getProvider();
        engineRef.current?.setRemoteCursors(
          model && provider ? readRemoteCursors(model.doc.clientID, provider) : [],
        );
      }

      return {
        attach(doc, session) {
          model = new BoardModel(doc, session.participantId);
          modelRef.current = model;
          engineRef.current?.setModel(model);
        },
        onAwarenessChange: syncCursors,
        onSync() {
          if (model?.getSchemaStatus() === "pending" && getProvider()?.isSynced) {
            model.checkSchema(editableRef.current);
          }
          syncCursors();
        },
        detach() {
          // Runs while the document is alive, so a stroke in progress is saved.
          if (modelRef.current === model) engineRef.current?.setModel(null);
        },
        release() {
          model?.destroy();
          if (modelRef.current === model) modelRef.current = null;
          model = null;
          engineRef.current?.setRemoteCursors([]);
        },
      };
    },
  );

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    let timer: number | null = null;
    let latest: Point | null = null;

    const instance = new BoardEngine(stage, canvas, {
      onCursorMove(world) {
        latest = world;
        if (timer !== null) return;
        timer = window.setTimeout(() => {
          timer = null;
          providerRef.current?.awareness?.setLocalStateField(
            "cursor",
            editableRef.current ? latest : null,
          );
        }, CURSOR_SEND_MS);
      },
    });
    engineRef.current = instance;
    instance.setModel(modelRef.current);
    setEngine(instance);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      instance.destroy();
      if (engineRef.current === instance) engineRef.current = null;
      setEngine(null);
    };
  }, [providerRef]);

  useEffect(() => {
    engine?.setEditable(editable);
    if (!editable) providerRef.current?.awareness?.setLocalStateField("cursor", null);
  }, [editable, engine, providerRef]);

  const snapshot = useSyncExternalStore(
    engine?.subscribe ?? noSubscribe,
    engine?.getSnapshot ?? initialSnapshot,
  );

  return (
    <div className="classroom-whiteboard-content tb-board">
      <Toolbar
        canEdit={editable}
        connection={connection}
        onRedo={() => engine?.redo()}
        onTool={(id) => engine?.setTool(id)}
        onUndo={() => engine?.undo()}
        onZoomIn={() => engine?.zoomIn()}
        onZoomOut={() => engine?.zoomOut()}
        onZoomReset={() => engine?.resetZoom()}
        snapshot={snapshot}
      />
      <div className="tb-stage" ref={stageRef} tabIndex={0}>
        <canvas aria-label="Whiteboard" className="tb-canvas" ref={canvasRef} />
        {snapshot.schema === "legacy" && (
          <div className="tb-banner" role="status">
            This board was made with the previous whiteboard and can't be shown here.
          </div>
        )}
        {snapshot.schema === "newer" && (
          <div className="tb-banner" role="status">
            This board was saved by a newer version. Refresh the page to edit it.
          </div>
        )}
        {error ? (
          <div className="classroom-board-error" role="alert">
            <strong>Could not connect to the board</strong>
            <button onClick={retry} type="button">Retry</button>
          </div>
        ) : loading ? (
          <div className="classroom-whiteboard-loading">Connecting to board…</div>
        ) : null}
      </div>
    </div>
  );
}
