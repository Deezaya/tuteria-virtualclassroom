import type { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BoardEngine, type EngineSnapshot, type RemoteLaser } from "./engine/BoardEngine";
import type { Point } from "./engine/geometry";
import { BOARD_COLORS, type RemoteCursor } from "./engine/renderer";
import { BoardModel } from "./model/BoardModel";
import { createAssetService } from "./sync/assetService";
import { useBoardConnection } from "./sync/useBoardConnection";
import type { BoardProps } from "./types";
import { AddDialog } from "./ui/AddDialog";
import { Toolbar } from "./ui/Toolbar";
import "./board.css";

/** How often this person's cursor position is shared. */
const CURSOR_SEND_MS = 100;
/** How often a laser trail is shared while drawing. */
const LASER_SEND_MS = 50;
const NOTICE_MS = 4000;
/** One colour per person, picked from their participant id. */
const PERSON_COLORS = [
  "#e03131",
  "#2f9e44",
  "#1971c2",
  "#f08c00",
  "#9c36b5",
  "#0c8599",
  "#c2255c",
  "#5c940d",
  "#6741d9",
  "#d9480f",
];

const INITIAL_SNAPSHOT: EngineSnapshot = {
  tool: "hand",
  editable: false,
  canUpload: false,
  canAddPdf: false,
  canUndo: false,
  canRedo: false,
  zoom: 1,
  selectionCount: 0,
  schema: null,
  strokeColor: "#1f2937",
  fillColor: null,
  strokeWidth: 4,
  fontSize: 24,
  editingText: false,
};
const noSubscribe = () => () => undefined;
const initialSnapshot = () => INITIAL_SNAPSHOT;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Same colour for the same person every time they join. */
function colorForParticipant(participantId: string): string {
  let hash = 0;
  for (let i = 0; i < participantId.length; i += 1) {
    hash = (hash * 31 + participantId.charCodeAt(i)) | 0;
  }
  return PERSON_COLORS[Math.abs(hash) % PERSON_COLORS.length];
}

function readPresence(
  ownClientId: number,
  provider: HocuspocusProvider,
): { cursors: RemoteCursor[]; lasers: RemoteLaser[] } {
  const cursors: RemoteCursor[] = [];
  const lasers: RemoteLaser[] = [];
  const states = provider.awareness?.getStates();
  if (!states) return { cursors, lasers };
  for (const [clientId, state] of states) {
    if (clientId === ownClientId || !isRecord(state)) continue;
    const { user, cursor, color, laser } = state;
    if (!isRecord(user) || user.role === "observer" || typeof user.name !== "string") continue;
    const personColor =
      typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)
        ? color
        : PERSON_COLORS[clientId % PERSON_COLORS.length];
    if (isRecord(cursor) && typeof cursor.x === "number" && typeof cursor.y === "number") {
      cursors.push({ clientId, name: user.name, color: personColor, x: cursor.x, y: cursor.y });
    }
    if (Array.isArray(laser) && laser.length >= 4) {
      const points: Point[] = [];
      for (let i = 0; i + 1 < laser.length; i += 2) {
        const x = laser[i];
        const y = laser[i + 1];
        if (typeof x === "number" && typeof y === "number") points.push({ x, y });
      }
      lasers.push({ clientId, points, color: BOARD_COLORS.laser });
    }
  }
  return { cursors, lasers };
}

/** The custom whiteboard. Loaded only when VITE_BOARD_ENGINE=tuteria. */
export default function TuteriaWhiteboard({
  canEdit,
  canUpload = false,
  classRole,
  displayName,
  sessionId,
  roomId,
  spyMode,
}: BoardProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<BoardEngine | null>(null);
  const modelRef = useRef<BoardModel | null>(null);
  const [engine, setEngine] = useState<BoardEngine | null>(null);
  const [notice, setNotice] = useState("");
  /** The "Add to board" dialog, with a dropped file to start from. */
  const [addDialog, setAddDialog] = useState<{ file: File | null } | null>(null);
  const isHost = classRole === "admin" || classRole === "tutor";
  const assets = useMemo(
    () => createAssetService(sessionId, () => engineRef.current?.requestRender()),
    [sessionId],
  );
  const editable = canEdit && !spyMode;
  const editableRef = useRef(editable);
  editableRef.current = editable;

  const { connection, error, loading, providerRef, retry } = useBoardConnection(
    { classRole, displayName, roomId, sessionId, spyMode },
    ({ getProvider }) => {
      let model: BoardModel | null = null;
      let color: string | null = null;

      function syncPresence() {
        const provider = getProvider();
        const presence =
          model && provider ? readPresence(model.doc.clientID, provider) : { cursors: [], lasers: [] };
        engineRef.current?.setRemoteCursors(presence.cursors);
        engineRef.current?.setRemoteLasers(presence.lasers);
      }

      return {
        attach(doc, session) {
          model = new BoardModel(doc, session.participantId);
          color = colorForParticipant(session.participantId);
          modelRef.current = model;
          engineRef.current?.setModel(model);
        },
        onAwarenessChange: syncPresence,
        onSync() {
          const provider = getProvider();
          if (color && provider?.awareness && classRole !== "observer") {
            provider.awareness.setLocalStateField("color", color);
          }
          if (model?.getSchemaStatus() === "pending" && provider?.isSynced) {
            model.checkSchema(editableRef.current);
          }
          syncPresence();
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
          engineRef.current?.setRemoteLasers([]);
        },
      };
    },
  );

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    let cursorTimer: number | null = null;
    let latestCursor: Point | null = null;
    let laserTimer: number | null = null;
    let latestLaser: Point[] | null = null;
    const awareness = () => providerRef.current?.awareness;

    const instance = new BoardEngine(stage, canvas, {
      assets,
      onPdfDropped: (file) => setAddDialog({ file }),
      onCursorMove(world) {
        latestCursor = world;
        if (cursorTimer !== null) return;
        cursorTimer = window.setTimeout(() => {
          cursorTimer = null;
          awareness()?.setLocalStateField("cursor", editableRef.current ? latestCursor : null);
        }, CURSOR_SEND_MS);
      },
      onLaser(points) {
        latestLaser = points;
        if (points === null) {
          // Send the end straight away so the trail starts fading for everyone.
          if (laserTimer !== null) window.clearTimeout(laserTimer);
          laserTimer = null;
          awareness()?.setLocalStateField("laser", null);
          return;
        }
        if (laserTimer !== null) return;
        laserTimer = window.setTimeout(() => {
          laserTimer = null;
          const trail = latestLaser;
          awareness()?.setLocalStateField(
            "laser",
            editableRef.current && trail
              ? trail.flatMap(({ x, y }) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])
              : null,
          );
        }, LASER_SEND_MS);
      },
      onNotice: setNotice,
    });
    engineRef.current = instance;
    instance.setModel(modelRef.current);
    setEngine(instance);
    return () => {
      if (cursorTimer !== null) window.clearTimeout(cursorTimer);
      if (laserTimer !== null) window.clearTimeout(laserTimer);
      instance.destroy();
      if (engineRef.current === instance) engineRef.current = null;
      setEngine(null);
    };
  }, [assets, providerRef]);

  useEffect(() => {
    engine?.setEditable(editable);
    if (!editable) {
      providerRef.current?.awareness?.setLocalStateField("cursor", null);
      providerRef.current?.awareness?.setLocalStateField("laser", null);
    }
  }, [editable, engine, providerRef]);

  useEffect(() => {
    engine?.setCanUpload(canUpload);
  }, [canUpload, engine]);

  useEffect(() => {
    engine?.setHost(isHost);
  }, [engine, isHost]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const snapshot = useSyncExternalStore(
    engine?.subscribe ?? noSubscribe,
    engine?.getSnapshot ?? initialSnapshot,
  );

  return (
    <div className="classroom-whiteboard-content tb-board" ref={rootRef}>
      <Toolbar
        canEdit={editable}
        connection={connection}
        onRedo={() => engine?.redo()}
        onStyle={(patch) => engine?.setStyle(patch)}
        onTool={(id) => engine?.setTool(id)}
        onUndo={() => engine?.undo()}
        onAdd={() => setAddDialog({ file: null })}
        onZoomFit={() => engine?.zoomToContent()}
        onZoomIn={() => engine?.zoomIn()}
        onZoomOut={() => engine?.zoomOut()}
        onZoomReset={() => engine?.resetZoom()}
        rootRef={rootRef}
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
        {notice && (
          <div aria-live="polite" className="tb-notice" role="status">
            {notice}
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
      {addDialog && engine && (snapshot.canUpload || snapshot.canAddPdf) && (
        <AddDialog
          assets={assets}
          canAddImage={snapshot.canUpload}
          canAddPdf={snapshot.canAddPdf}
          engine={engine}
          initialFile={addDialog.file}
          onClose={() => setAddDialog(null)}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}
