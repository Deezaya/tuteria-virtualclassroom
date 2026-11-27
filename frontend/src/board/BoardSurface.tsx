import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BoardEngine, type EngineSnapshot, type ViewRect } from "./engine/BoardEngine";
import type { Point } from "./engine/geometry";
import { leadingControl } from "./leadingControl";
import { DEFAULT_TAB_ID, type Leading } from "./model/schema";
import type { AssetService } from "./sync/assetService";
import { findLeaderView, readPresence } from "./sync/presence";
import type { BoardPair } from "./sync/useBoardPair";
import { AddDialog } from "./ui/AddDialog";
import { TabBar } from "./ui/TabBar";
import { Toolbar } from "./ui/Toolbar";

/** How often this person's cursor position is shared. */
const CURSOR_SEND_MS = 100;
/** How often a laser trail is shared while drawing. */
const LASER_SEND_MS = 50;
/** How often the leading tutor's view is shared while it moves. */
const VIEW_SEND_MS = 100;
const NOTICE_MS = 4000;

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
  tab: DEFAULT_TAB_ID,
  tabs: [],
  canManageTabs: false,
  following: false,
};
const noSubscribe = () => () => undefined;
const initialSnapshot = () => INITIAL_SNAPSHOT;

const round = (value: number) => Math.round(value * 10) / 10;

type BoardSurfaceProps = {
  pair: BoardPair;
  assets: AssetService;
  /** May draw: the person's permission, and not a spy view. */
  canEdit: boolean;
  /** May add images (the File uploads permission). */
  canUpload: boolean;
  /** Tutor or admin. */
  isHost: boolean;
  displayName: string;
  /** Leading Mode on this board, or null. */
  leading: Leading | null;
  /** Whether this person may switch Leading Mode (tutors, not spying). */
  offerLead: boolean;
  /** Fires when view links for stored images arrive, to redraw. */
  subscribeUrls(listener: () => void): () => void;
};

/** The board on screen: canvas, toolbar, tabs and the add dialog. */
export function BoardSurface({
  pair,
  assets,
  canEdit,
  canUpload,
  isHost,
  displayName,
  leading,
  offerLead,
  subscribeUrls,
}: BoardSurfaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<BoardEngine | null>(null);
  const [engine, setEngine] = useState<BoardEngine | null>(null);
  const [notice, setNotice] = useState("");
  /** The "Add to board" dialog, with a dropped file to start from. */
  const [addDialog, setAddDialog] = useState<{ file: File | null } | null>(null);
  /** Leading Mode as seen by a student: following, or waiting for the tutor. */
  const [follow, setFollow] = useState<"following" | "waiting" | null>(null);
  const editableRef = useRef(canEdit);
  editableRef.current = canEdit;
  const isLeader = leading !== null && pair.participantId !== null && leading.by === pair.participantId;
  const isLeaderRef = useRef(isLeader);
  isLeaderRef.current = isLeader;
  const { getProvider, subscribeAwareness, subscribeDetach } = pair;

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    let cursorTimer: number | null = null;
    let latestCursor: Point | null = null;
    let laserTimer: number | null = null;
    let latestLaser: Point[] | null = null;
    let viewTimer: number | null = null;
    let latestView: ViewRect | null = null;
    const awareness = () => getProvider()?.awareness;

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
            editableRef.current && trail ? trail.flatMap(({ x, y }) => [round(x), round(y)]) : null,
          );
        }, LASER_SEND_MS);
      },
      onView(view) {
        // Only the tutor leading shares their view.
        if (!isLeaderRef.current) return;
        latestView = view;
        if (viewTimer !== null) return;
        viewTimer = window.setTimeout(() => {
          viewTimer = null;
          const shared = latestView;
          if (!isLeaderRef.current || !shared) return;
          awareness()?.setLocalStateField("viewport", {
            tab: shared.tab,
            x: round(shared.x),
            y: round(shared.y),
            w: round(shared.w),
            h: round(shared.h),
          });
        }, VIEW_SEND_MS);
      },
      onNotice: setNotice,
    });
    engineRef.current = instance;
    setEngine(instance);
    return () => {
      if (cursorTimer !== null) window.clearTimeout(cursorTimer);
      if (laserTimer !== null) window.clearTimeout(laserTimer);
      if (viewTimer !== null) window.clearTimeout(viewTimer);
      // This board leaves the screen: stop showing a cursor or view on it.
      const state = awareness();
      state?.setLocalStateField("cursor", null);
      state?.setLocalStateField("laser", null);
      state?.setLocalStateField("viewport", null);
      instance.destroy();
      if (engineRef.current === instance) engineRef.current = null;
      setEngine(null);
    };
  }, [assets, getProvider]);

  // Attach the documents as they connect and reconnect.
  useEffect(() => {
    engine?.setModel(pair.main);
  }, [engine, pair.main]);
  useEffect(() => {
    engine?.setLockedModel(pair.locked);
  }, [engine, pair.locked]);
  useEffect(() => {
    if (!engine) return;
    // A document closing: let go of it while it's alive, so a stroke in
    // progress is saved.
    return subscribeDetach((model) => {
      if (model === pair.main) engine.setModel(null);
      if (model === pair.locked) engine.setLockedModel(null);
    });
  }, [engine, pair.locked, pair.main, subscribeDetach]);

  useEffect(() => {
    engine?.setEditable(canEdit);
    if (!canEdit) {
      getProvider()?.awareness?.setLocalStateField("cursor", null);
      getProvider()?.awareness?.setLocalStateField("laser", null);
    }
  }, [canEdit, engine, getProvider]);

  useEffect(() => {
    if (!engine) return;
    return subscribeUrls(() => engine.requestRender());
  }, [engine, subscribeUrls]);

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

  // Others' cursors and lasers on the tab being shown.
  useEffect(() => {
    if (!engine) return;
    const sync = () => {
      const presence = pair.main
        ? readPresence(pair.main.doc.clientID, getProvider(), engine.getTab())
        : { cursors: [], lasers: [] };
      engine.setRemoteCursors(presence.cursors);
      engine.setRemoteLasers(presence.lasers);
    };
    sync();
    return subscribeAwareness(sync);
  }, [engine, getProvider, pair.main, snapshot.tab, subscribeAwareness]);

  // Tell others which tab this person is on, so cursors show only on the same tab.
  useEffect(() => {
    getProvider()?.awareness?.setLocalStateField("tab", snapshot.tab);
  }, [getProvider, pair.main, snapshot.tab]);

  // Leading Mode, tutor side: share the view while leading.
  useEffect(() => {
    const awareness = getProvider()?.awareness;
    if (!awareness || !engine) return;
    if (isLeader) {
      const view = engine.getView();
      awareness.setLocalStateField("viewport", {
        tab: view.tab,
        x: round(view.x),
        y: round(view.y),
        w: round(view.w),
        h: round(view.h),
      });
    } else {
      awareness.setLocalStateField("viewport", null);
    }
  }, [engine, getProvider, isLeader, pair.main]);

  // Leading Mode, student side: follow the leading tutor's view. If they
  // aren't here, the student can move around until they come back.
  const followsLeader = leading !== null && !isHost && !isLeader;
  const leaderId = leading?.by ?? null;
  useEffect(() => {
    if (!engine) return;
    if (!followsLeader || !leaderId) {
      engine.setFollow(null);
      setFollow(null);
      return;
    }
    const sync = () => {
      const view = findLeaderView(getProvider(), leaderId);
      engine.setFollow(view);
      setFollow(view ? "following" : "waiting");
    };
    sync();
    const unsubscribe = subscribeAwareness(sync);
    return () => {
      unsubscribe();
      engine.setFollow(null);
    };
  }, [engine, followsLeader, getProvider, leaderId, subscribeAwareness]);

  // Leading Mode is switched from the Host controls panel (App.tsx). The
  // board tells the panel its state and does the switching.
  const toggleLeadRef = useRef<() => void>(() => undefined);
  toggleLeadRef.current = () => {
    const locked = pair.locked;
    if (!locked || !pair.participantId || !offerLead || !snapshot.canManageTabs) return;
    locked.setLeading(leading ? null : { by: pair.participantId, name: displayName });
  };
  const [leadOwner] = useState(() => ({}));
  const leadAvailable = offerLead && snapshot.canManageTabs;
  useEffect(() => {
    leadingControl.publish(
      leadOwner,
      { available: leadAvailable, active: leading !== null, leaderName: leading?.name ?? null, byMe: isLeader },
      () => toggleLeadRef.current(),
    );
  }, [isLeader, leadAvailable, leadOwner, leading]);
  useEffect(() => () => leadingControl.clear(leadOwner), [leadOwner]);

  return (
    <div className="classroom-whiteboard-content tb-board" ref={rootRef}>
      <Toolbar
        canEdit={canEdit}
        connection={pair.connection}
        followingName={follow === "following" ? leading?.name : null}
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
      {engine && (
        <TabBar
          canManage={snapshot.canManageTabs}
          current={snapshot.tab}
          describePdf={(pdfId) => engine.describePdf(pdfId)}
          onAdd={() => engine.addTab()}
          onDelete={(id) => engine.deleteTab(id)}
          onRemovePdf={(pdfId) => engine.removePdf(pdfId)}
          onRename={(id, name) => engine.renameTab(id, name)}
          onSwitch={(id) => engine.setTab(id)}
          switchLocked={snapshot.following}
          tabs={snapshot.tabs}
        />
      )}
      <div className={`tb-stage${snapshot.following ? " is-following" : ""}`} ref={stageRef} tabIndex={0}>
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
        {follow === "following" && leading && (
          <div className="tb-follow-pill" role="status">
            Following {leading.name}
          </div>
        )}
        {follow === "waiting" && leading && (
          <div className="tb-follow-pill is-waiting" role="status">
            Leading mode is on. Waiting for {leading.name}…
          </div>
        )}
        {isHost && leading && !isLeader && (
          <div className="tb-follow-pill is-waiting" role="status">
            {leading.name} is leading. Students follow their view.
          </div>
        )}
        {notice && (
          <div aria-live="polite" className="tb-notice" role="status">
            {notice}
          </div>
        )}
        {pair.error ? (
          <div className="classroom-board-error" role="alert">
            <strong>Could not connect to the board</strong>
            <button onClick={pair.retry} type="button">Retry</button>
          </div>
        ) : pair.loading ? (
          <div className="classroom-whiteboard-loading">Connecting to board…</div>
        ) : null}
      </div>
      {addDialog && engine && (snapshot.canUpload || snapshot.canAddPdf) && (
        <AddDialog
          assets={assets}
          canAddImage={snapshot.canUpload}
          canAddPdf={snapshot.canAddPdf}
          canUseTabs={snapshot.canManageTabs}
          engine={engine}
          initialFile={addDialog.file}
          onClose={() => setAddDialog(null)}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}
