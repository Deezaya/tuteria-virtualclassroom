import type { BoardModel, ItemPatch, SchemaStatus } from "../model/BoardModel";
import { BoardHistory } from "../model/history";
import {
  BOARD_FONT,
  DEFAULT_TAB_ID,
  DEFAULT_TAB_NAME,
  isPicture,
  type BoardItem,
  type BoardTab,
} from "../model/schema";
import type { AssetService } from "../sync/assetService";
import { EraserTool } from "../tools/eraserTool";
import { HandTool } from "../tools/handTool";
import { LaserTool } from "../tools/laserTool";
import { PenTool } from "../tools/penTool";
import { SelectTool } from "../tools/selectTool";
import { ShapeTool } from "../tools/shapeTool";
import { TextTool } from "../tools/textTool";
import type { BoardPointer, DrawStyle, Tool, ToolHost, ToolId } from "../tools/types";
import {
  clampZoom,
  panBy,
  screenToWorld,
  steppedZoom,
  visibleWorldBounds,
  zoomAt,
  type Camera,
} from "./camera";
import { type Bounds, type Point } from "./geometry";
import { ImageImportError, prepareImage } from "./imageImport";
import { ImageStore } from "./imageStore";
import { ItemCache } from "./itemCache";
import { hitItem, itemTouchesBounds, type ItemGeometry } from "./items";
import { renderBoard, type LaserTrail, type RemoteCursor } from "./renderer";
import { SelectionBar } from "./selectionBar";
import { TextEditor } from "./textEditor";
import { clearTextLayouts, fontString } from "./textLayout";

export type EngineSnapshot = {
  tool: ToolId;
  editable: boolean;
  canUpload: boolean;
  /** Tutors and admins who can edit, with storage available. */
  canAddPdf: boolean;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  selectionCount: number;
  schema: SchemaStatus | null;
  /** Style shown in the toolbar: the selection's, or the active tool's. */
  strokeColor: string;
  fillColor: string | null;
  strokeWidth: number;
  fontSize: number;
  editingText: boolean;
  /** The tab being shown, and every tab in order. */
  tab: string;
  tabs: readonly BoardTab[];
  /** Tutors and admins who can edit: may add, rename and delete tabs. */
  canManageTabs: boolean;
  /** Leading Mode: the view follows the tutor's, and can't be moved. */
  following: boolean;
};

/** A part of the board in world units, on one tab. */
export type ViewRect = { tab: string; x: number; y: number; w: number; h: number };

export type StylePatch = Partial<{
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  fontSize: number;
}>;

export type RemoteLaser = { clientId: number; points: Point[]; color: string };

/**
 * Where PDF pages go. "stack": below everything on the board, locked.
 * "tabs": each page on a new tab of its own, locked.
 * "view": where the person is looking, movable.
 */
export type PdfPlacement = "stack" | "tabs" | "view";
export type PdfPlacer = { next(aspect: number): { x: number; y: number; w: number; h: number } };
export type UploadedPage = { assetId: string; key: string; mime: string; width: number; height: number; bytes: number };

/** World width of a placed PDF page. */
const PDF_PAGE_WIDTH = 800;
const PDF_PAGE_GAP = 24;

type EngineOptions = {
  /** Board file storage (R2). Without it, images can't be added. */
  assets?: AssetService;
  /** World position of this person's pointer, or null when it leaves. */
  onCursorMove?: (world: Point | null) => void;
  /** This person's laser trail, or null when it ends. */
  onLaser?: (points: Point[] | null) => void;
  /** A short message to show, e.g. an image that is too large. */
  onNotice?: (message: string) => void;
  /** A PDF dropped on the board; the page opens the PDF dialog. */
  onPdfDropped?: (file: File) => void;
  /** The part of the board on screen changed (camera, size or tab). */
  onView?: (view: ViewRect) => void;
};

type Gesture =
  | { kind: "tool"; pointerId: number; tool: Tool }
  | { kind: "pan"; pointerId: number; last: Point }
  | { kind: "pinch"; ids: [number, number]; startDistance: number; anchor: Point; startZoom: number };

const EMPTY: ReadonlySet<string> = new Set();
const NO_ITEMS: readonly BoardItem[] = [];
const DEFAULT_TABS: readonly BoardTab[] = [
  { id: DEFAULT_TAB_ID, name: DEFAULT_TAB_NAME, z: "", pdfId: null },
];
const HOME: Camera = { x: 0, y: 0, zoom: 1 };
const LASER_FADE_MS = 600;
/** New images take at most this share of the visible board. */
const IMAGE_FIT = 0.6;

const SHORTCUTS: Record<string, ToolId> = {
  v: "select",
  h: "hand",
  p: "pen",
  m: "highlighter",
  e: "eraser",
  r: "rect",
  o: "ellipse",
  l: "line",
  a: "arrow",
  t: "text",
  k: "laser",
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/**
 * The drawing engine. It owns the canvas, the camera, the tools and all
 * input, and draws the attached BoardModel. It knows nothing about React,
 * Hocuspocus or the toolbar's look.
 */
export class BoardEngine implements ToolHost {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly options: EngineOptions;
  private readonly tools: Record<ToolId, Tool>;
  private readonly cache = new ItemCache();
  private readonly images: ImageStore;
  private readonly textEditor: TextEditor;
  private readonly selectionBar: SelectionBar;
  private readonly listeners = new Set<() => void>();
  private readonly pointers = new Map<number, { screen: Point; type: string }>();
  private readonly cleanups: Array<() => void> = [];
  private readonly remoteLasers = new Map<
    number,
    { points: Point[]; color: string; updatedAt: number; active: boolean }
  >();
  /** The board's main document: everyone with editing writes here. */
  private model: BoardModel | null = null;
  private unsubscribeModel: (() => void) | null = null;
  /** The board's locked layer: drawn underneath, written only by hosts. */
  private lockedModel: BoardModel | null = null;
  private unsubscribeLocked: (() => void) | null = null;
  private readonly history = new BoardHistory();
  /** Both layers' items on the shown tab, in drawing order, rebuilt when either changes. */
  private combined: {
    main: readonly BoardItem[];
    locked: readonly BoardItem[];
    tab: string;
    items: BoardItem[];
    byId: Map<string, { item: BoardItem; layer: "main" | "locked" }>;
  } | null = null;
  private camera: Camera = HOME;
  /** The tab being shown, and where the camera was on the others. */
  private tab = DEFAULT_TAB_ID;
  private readonly tabCameras = new Map<string, Camera>();
  /** Leading Mode: the tutor's view this board follows, or null. */
  private follow: ViewRect | null = null;
  /** "Each page on its own tab": the tab the next page goes after. */
  private pdfTabAfter: string | null = null;
  private pdfTabFirst = false;
  private allowedToEdit = false;
  private allowedToUpload = false;
  /** Tutors and admins: may add PDFs and delete locked items. */
  private host = false;
  private toolId: ToolId = "hand";
  /** The tool to return to when editing is allowed again. */
  private preferredTool: ToolId = "pen";
  private selection = new Set<string>();
  private cursors: RemoteCursor[] = [];
  private gesture: Gesture | null = null;
  private spaceHeld = false;
  private penSeen = false;
  private frame: number | null = null;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private style: DrawStyle = {
    stroke: "#1f2937",
    fill: null,
    strokeWidth: 4,
    fontSize: 24,
    highlighter: "#facc15",
    highlighterWidth: 20,
  };
  private snapshot: EngineSnapshot;
  private destroyed = false;

  constructor(container: HTMLElement, canvas: HTMLCanvasElement, options: EngineOptions = {}) {
    this.container = container;
    this.canvas = canvas;
    this.options = options;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available.");
    this.ctx = ctx;
    this.images = new ImageStore(() => this.requestRender());
    this.textEditor = new TextEditor({
      container,
      getModel: () => this.getEditableModel(),
      getItem: (id) => this.getItem(id),
      getCamera: () => this.camera,
      onChange: () => {
        this.updateSnapshot();
        this.requestRender();
      },
    });
    this.selectionBar = new SelectionBar(container, {
      onDelete: () => this.deleteSelection(),
      onRemovePdf: () => this.removeSelectedPdf(),
      onLock: () => this.lockSelection(),
      onUnlock: () => this.unlockSelection(),
    });
    this.cleanups.push(this.history.subscribe(() => this.updateSnapshot()));
    this.tools = {
      select: new SelectTool(this),
      hand: new HandTool(this),
      pen: new PenTool(this, "pen"),
      highlighter: new PenTool(this, "highlighter"),
      eraser: new EraserTool(this),
      rect: new ShapeTool(this, "rect"),
      ellipse: new ShapeTool(this, "ellipse"),
      line: new ShapeTool(this, "line"),
      arrow: new ShapeTool(this, "arrow"),
      text: new TextTool(this),
      laser: new LaserTool(this),
    };
    this.snapshot = this.buildSnapshot();

    const resizeObserver = new ResizeObserver(() => this.resize());
    resizeObserver.observe(container);
    this.cleanups.push(() => resizeObserver.disconnect());

    this.listen(canvas, "pointerdown", this.onPointerDown);
    this.listen(canvas, "pointermove", this.onPointerMove);
    this.listen(canvas, "pointerup", this.onPointerUp);
    this.listen(canvas, "pointercancel", this.onPointerCancel);
    this.listen(canvas, "pointerleave", this.onPointerLeave);
    this.listen(canvas, "wheel", this.onWheel, { passive: false });
    this.listen(canvas, "contextmenu", (event) => event.preventDefault());
    // The engine moves focus itself. The browser's own focus change on
    // mousedown would otherwise close a text box the moment it opens.
    this.listen(canvas, "mousedown", (event) => event.preventDefault());
    this.listen(container, "keydown", this.onKeyDown);
    this.listen(container, "keyup", this.onKeyUp);
    this.listen(container, "paste", this.onPaste);
    this.listen(container, "dragover", this.onDragOver);
    this.listen(container, "drop", this.onDrop);
    this.listen(window, "blur", this.onBlur);
    this.resize();

    // Text is measured with the web font, so measure again once it arrives.
    document.fonts?.load(fontString(24, BOARD_FONT)).then(
      () => {
        if (this.destroyed) return;
        clearTextLayouts();
        this.cache.clear();
        this.requestRender();
      },
      () => undefined,
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.textEditor.end();
    this.endGesture(true);
    this.setModel(null);
    this.setLockedModel(null);
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.cleanups.forEach((cleanup) => cleanup());
    this.selectionBar.destroy();
    this.listeners.clear();
  }

  // ---- public API (React and the toolbar) ----

  /** Stable function for useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Stable function for useSyncExternalStore. */
  getSnapshot = (): EngineSnapshot => this.snapshot;

  setModel(model: BoardModel | null): void {
    if (model === this.model) return;
    this.textEditor.end();
    this.endGesture(true);
    this.unsubscribeModel?.();
    this.unsubscribeModel = null;
    if (this.model) this.history.detach(this.model);
    this.model = model;
    this.combined = null;
    this.selection = new Set();
    this.cache.clear();
    this.images.clear();
    if (model) {
      model.setActiveTab(this.tab);
      this.history.attach(model);
      this.unsubscribeModel = model.subscribe(() => this.onModelChange());
    }
    this.applyEditability();
  }

  /** Attaches the board's locked layer (or detaches it with null). */
  setLockedModel(model: BoardModel | null): void {
    if (model === this.lockedModel) return;
    this.endGesture(true);
    this.unsubscribeLocked?.();
    this.unsubscribeLocked = null;
    if (this.lockedModel) this.history.detach(this.lockedModel);
    this.lockedModel = model;
    this.combined = null;
    if (model) {
      model.setActiveTab(this.tab);
      this.history.attach(model);
      this.unsubscribeLocked = model.subscribe(() => this.onModelChange());
    }
    this.onModelChange();
    this.updateSnapshot();
    this.requestRender();
  }

  /** Whether this person may edit. The schema check can still block it. */
  setEditable(editable: boolean): void {
    if (editable === this.allowedToEdit) return;
    // Cancel before blocking writes, so a half-drawn stroke is undone
    // rather than left behind locally.
    if (!editable) {
      this.textEditor.end();
      this.endGesture(false);
    }
    this.allowedToEdit = editable;
    this.applyEditability();
  }

  /** Whether this person may add images (the File uploads permission). */
  setCanUpload(canUpload: boolean): void {
    this.allowedToUpload = canUpload;
    this.updateSnapshot();
  }

  /** Whether this person is a tutor or admin. */
  setHost(host: boolean): void {
    this.host = host;
    this.updateSnapshot();
    this.requestRender();
  }

  setTool(id: ToolId): void {
    if (this.tools[id].edits && !this.isEditable()) return;
    this.textEditor.end();
    if (id === this.toolId) return;
    this.endGesture(true);
    this.tools[this.toolId].hover?.(null);
    this.toolId = id;
    if (this.isEditable()) this.preferredTool = id;
    if (id !== "select") this.setSelection([]);
    this.updateCursor();
    this.updateSnapshot();
    this.requestRender();
  }

  /**
   * Changes the drawing style. With items selected, they change too, as
   * one undo step.
   */
  setStyle(patch: StylePatch): void {
    const highlighter = this.toolId === "highlighter";
    const next = { ...this.style };
    if (patch.stroke !== undefined) {
      if (highlighter) next.highlighter = patch.stroke;
      else next.stroke = patch.stroke;
    }
    if (patch.strokeWidth !== undefined) {
      if (highlighter) next.highlighterWidth = patch.strokeWidth;
      else next.strokeWidth = patch.strokeWidth;
    }
    if (patch.fill !== undefined) next.fill = patch.fill;
    if (patch.fontSize !== undefined) next.fontSize = patch.fontSize;
    this.style = next;

    const model = this.getEditableModel();
    const editingId = this.textEditor.editingId;
    const targets = editingId ? [editingId] : [...this.selection];
    if (model && targets.length > 0) {
      const patches = new Map<string, ItemPatch>();
      for (const id of targets) {
        const item = model.getItem(id);
        if (!item || item.locked) continue;
        const itemPatch: ItemPatch = {};
        if (patch.stroke !== undefined && !isPicture(item)) itemPatch.stroke = patch.stroke;
        if (patch.fill !== undefined && (item.type === "rect" || item.type === "ellipse")) {
          itemPatch.fill = patch.fill;
        }
        if (patch.strokeWidth !== undefined && item.type !== "text" && !isPicture(item)) {
          itemPatch.strokeWidth = patch.strokeWidth;
        }
        if (patch.fontSize !== undefined && item.type === "text") itemPatch.fontSize = patch.fontSize;
        if (Object.keys(itemPatch).length > 0) patches.set(id, itemPatch);
      }
      if (patches.size > 0) {
        // While typing, a style change belongs to the same undo step.
        if (!editingId) model.endStep();
        model.updateItems(patches);
        if (!editingId) model.endStep();
      }
    }
    this.updateSnapshot();
  }

  // ---- tabs ----

  /** The board's tabs in order. The list lives in the locked layer. */
  getTabs(): readonly BoardTab[] {
    return this.lockedModel?.getTabs() ?? DEFAULT_TABS;
  }

  getTab(): string {
    return this.tab;
  }

  /** Shows another tab. Not while following the tutor in Leading Mode. */
  setTab(id: string): void {
    if (this.follow) return;
    if (!this.getTabs().some((tab) => tab.id === id)) return;
    this.switchTab(id);
  }

  /** Tutors and admins who can edit. */
  canManageTabs(): boolean {
    return this.getWritableLockedModel() !== null && this.getEditableModel() !== null;
  }

  /** Adds a tab after the last one and shows it. */
  addTab(): void {
    const locked = this.getWritableLockedModel();
    if (!locked || !this.canManageTabs()) return;
    const names = new Set(this.getTabs().map((tab) => tab.name));
    let number = this.getTabs().length + 1;
    while (names.has(`Page ${number}`)) number += 1;
    this.endGesture(true);
    let id = "";
    this.history.group(() => {
      id = locked.addTab(`Page ${number}`);
    });
    this.switchTab(id);
  }

  renameTab(id: string, name: string): void {
    const locked = this.getWritableLockedModel();
    if (!locked || !this.canManageTabs() || !name.trim()) return;
    this.history.group(() => locked.renameTab(id, name));
  }

  /** Deletes a tab and everything on it, in both layers, as one undo step. */
  deleteTab(id: string): void {
    this.deleteTabsAndItems([id], () => false);
  }

  /** Everything a PDF brought: its pages on any tab, and the tabs made for it. */
  describePdf(pdfId: string): { name: string; pages: number; tabs: number } {
    let name = "";
    let pages = 0;
    for (const item of this.allItems()) {
      if (item.type === "pdfPage" && item.pdfId === pdfId) {
        pages += 1;
        name ||= item.pdfName;
      }
    }
    const tabs = this.getTabs().filter((tab) => tab.pdfId === pdfId).length;
    return { name: name || "this PDF", pages, tabs };
  }

  /** Removes every page of a PDF and the tabs made for it, as one undo step. */
  removePdf(pdfId: string): void {
    if (!this.host || !pdfId) return;
    const tabs = this.getTabs().filter((tab) => tab.pdfId === pdfId).map((tab) => tab.id);
    this.deleteTabsAndItems(tabs, (item) => item.type === "pdfPage" && item.pdfId === pdfId);
    this.setSelection([]);
  }

  /**
   * Leading Mode: follows the tutor's view (their tab, and at least the part
   * of the board they see), or stops following with null.
   */
  setFollow(view: ViewRect | null): void {
    const current = this.follow;
    const same =
      current !== null &&
      view !== null &&
      current.tab === view.tab &&
      current.x === view.x &&
      current.y === view.y &&
      current.w === view.w &&
      current.h === view.h;
    // Presence changes often (everyone's cursors); only move when the view did.
    if (same || (current === null && view === null)) return;
    this.follow = view;
    if (view) {
      if (view.tab !== this.tab && this.getTabs().some((tab) => tab.id === view.tab)) {
        this.switchTab(view.tab);
      }
      this.fitView(view);
    }
    this.updateSnapshot();
  }

  /** The part of the board on screen now. */
  getView(): ViewRect {
    const { x, y, zoom } = this.camera;
    return { tab: this.tab, x, y, w: this.width / zoom, h: this.height / zoom };
  }

  setRemoteCursors(cursors: RemoteCursor[]): void {
    this.cursors = cursors;
    this.requestRender();
  }

  /** Laser trails from other people. A trail that disappears fades out. */
  setRemoteLasers(lasers: RemoteLaser[]): void {
    const now = performance.now();
    const seen = new Set<number>();
    for (const laser of lasers) {
      seen.add(laser.clientId);
      this.remoteLasers.set(laser.clientId, {
        points: laser.points,
        color: laser.color,
        updatedAt: now,
        active: true,
      });
    }
    for (const [clientId, laser] of this.remoteLasers) {
      if (!seen.has(clientId) && laser.active) {
        laser.active = false;
        laser.updatedAt = now;
      }
    }
    this.requestRender();
  }

  undo(): void {
    if (!this.getEditableModel()) return;
    this.textEditor.end();
    this.endGesture(true);
    this.history.undo();
  }

  redo(): void {
    if (!this.getEditableModel()) return;
    this.textEditor.end();
    this.endGesture(true);
    this.history.redo();
  }

  deleteSelection(): void {
    const model = this.getEditableModel();
    if (!model || this.selection.size === 0) return;
    this.endGesture(true);
    const ids = [...this.selection].filter((id) => {
      const item = this.getItem(id);
      return item !== undefined && this.canDelete(item);
    });
    this.deleteFromLayers(ids);
    this.setSelection([]);
  }

  /** Deletes items from whichever layer holds them, as one undo step. */
  private deleteFromLayers(ids: string[]): void {
    const main = this.getEditableModel();
    const locked = this.getWritableLockedModel();
    const mainIds = ids.filter((id) => this.layerOf(id) === "main");
    const lockedIds = ids.filter((id) => this.layerOf(id) === "locked");
    this.history.group(() => {
      if (main && mainIds.length > 0) main.deleteItems(mainIds);
      if (locked && lockedIds.length > 0) locked.deleteItems(lockedIds);
    });
  }

  /**
   * Moves the selected items into the locked layer (tutors and admins).
   * Nobody can then move, resize or erase them; students can't select them.
   */
  lockSelection(): void {
    const main = this.getEditableModel();
    const locked = this.getWritableLockedModel();
    if (!main || !locked) return;
    this.endGesture(true);
    const ids = [...this.selection].filter((id) => this.layerOf(id) === "main");
    this.history.group(() => {
      for (const id of ids) {
        const item = main.getItem(id);
        if (!item) continue;
        if (isPicture(item)) {
          const asset = main.getAsset(item.assetId);
          if (asset) locked.copyAsset(asset);
        }
        locked.importItem({ ...item, locked: false });
      }
      main.deleteItems(ids);
    });
    this.setSelection(ids);
  }

  /** Moves the selected items out of the locked layer, so they can be changed again. */
  unlockSelection(): void {
    const main = this.getEditableModel();
    const locked = this.getWritableLockedModel();
    if (!main || !this.host) return;
    this.endGesture(true);
    const ids = [...this.selection];
    this.history.group(() => {
      const moved: string[] = [];
      const legacy = new Map<string, ItemPatch>();
      for (const id of ids) {
        if (this.layerOf(id) === "locked" && locked) {
          const item = locked.getItem(id);
          if (!item) continue;
          if (isPicture(item)) {
            const asset = locked.getAsset(item.assetId);
            if (asset) main.copyAsset(asset);
          }
          main.importItem({ ...item, locked: false });
          moved.push(id);
        } else if (main.getItem(id)?.locked) {
          // Locked before the locked layer existed (Phase 3): just clear the flag.
          legacy.set(id, { locked: false });
        }
      }
      if (locked && moved.length > 0) locked.deleteItems(moved);
      if (legacy.size > 0) main.updateItems(legacy);
    });
    this.setSelection(ids);
  }

  /** Removes every page of the PDF the selected page came from (tutors and admins). */
  removeSelectedPdf(): void {
    const model = this.getEditableModel();
    if (!model || !this.host) return;
    const page = [...this.selection].map((id) => this.getItem(id)).find((item) => item?.type === "pdfPage");
    if (page?.type !== "pdfPage" || !page.pdfId) return;
    const { name, pages, tabs } = this.describePdf(page.pdfId);
    const tabText =
      tabs > 0 ? `, and its ${tabs} tab${tabs === 1 ? "" : "s"} with everything drawn on them` : "";
    if (!window.confirm(`Remove all ${pages} page${pages === 1 ? "" : "s"} of ${name}${tabText}? You can undo this.`)) {
      return;
    }
    this.endGesture(true);
    this.removePdf(page.pdfId);
  }

  /**
   * Adds an image to the board, centred on `at` or on the view. The image
   * is uploaded to storage first. Throws with a message fit to show people.
   */
  async insertImage(file: Blob, at?: Point, onProgress?: (fraction: number) => void): Promise<void> {
    const assets = this.options.assets;
    if (!this.getEditableModel() || !assets) throw new ImageImportError("You can't add images right now.");
    if (!this.allowedToUpload) throw new ImageImportError("Your tutor hasn't allowed file uploads.");
    const prepared = await prepareImage(file);
    const { assetId, key } = await assets.upload(prepared.blob, "image", onProgress);
    const model = this.getEditableModel();
    if (!model || this.destroyed) throw new ImageImportError("Editing was turned off before the image was added.");
    const view = visibleWorldBounds(this.camera, this.width, this.height);
    const center = at ?? { x: (view.minX + view.maxX) / 2, y: (view.minY + view.maxY) / 2 };
    const fit = Math.min(
      1,
      ((view.maxX - view.minX) * IMAGE_FIT) / prepared.width,
      ((view.maxY - view.minY) * IMAGE_FIT) / prepared.height,
    );
    const w = prepared.width * fit;
    const h = prepared.height * fit;
    const id = crypto.randomUUID();
    model.endStep();
    model.addAsset({
      id: assetId,
      mime: prepared.mime,
      width: prepared.width,
      height: prepared.height,
      bytes: prepared.blob.size,
      key,
      url: null,
      dataURL: null,
    });
    model.createItem({
      id,
      type: "image",
      x: center.x - w / 2,
      y: center.y - h / 2,
      rotation: 0,
      stroke: "#000000",
      fill: null,
      strokeWidth: 0,
      opacity: 1,
      locked: false,
      assetId,
      w,
      h,
    });
    model.endStep();
    this.setTool("select");
    this.setSelection([id]);
  }

  /** True when this person may add PDFs: tutors and admins who can edit. */
  canAddPdf(): boolean {
    return this.getWritableLockedModel() !== null && this.options.assets !== undefined;
  }

  /**
   * Starts a PDF import: works out where each page goes. Pages are
   * PDF_PAGE_WIDTH wide and stacked downwards with a small gap.
   */
  beginPdfImport(placement: PdfPlacement): PdfPlacer {
    this.getEditableModel()?.endStep();
    this.getWritableLockedModel()?.endStep();
    if (placement === "tabs") {
      // Every page on a new tab, at the same spot; addPdfPage makes the tab.
      this.pdfTabAfter = this.tab;
      this.pdfTabFirst = true;
      return { next: (aspect) => ({ x: 0, y: 0, w: PDF_PAGE_WIDTH, h: PDF_PAGE_WIDTH * aspect }) };
    }
    this.pdfTabAfter = null;
    let x: number;
    let y: number;
    if (placement === "stack") {
      const items = this.getItems();
      if (items.length === 0) {
        x = 0;
        y = 0;
      } else {
        let minX = Infinity;
        let maxY = -Infinity;
        for (const item of items) {
          const b = this.geometryOf(item).bounds;
          minX = Math.min(minX, b.minX);
          maxY = Math.max(maxY, b.maxY);
        }
        x = minX;
        y = maxY + 60;
      }
    } else {
      const view = visibleWorldBounds(this.camera, this.width, this.height);
      x = (view.minX + view.maxX) / 2 - PDF_PAGE_WIDTH / 2;
      y = view.minY + 40 / this.camera.zoom;
    }
    let first = true;
    return {
      next: (aspect) => {
        const h = PDF_PAGE_WIDTH * aspect;
        const area = { x, y, w: PDF_PAGE_WIDTH, h };
        y += h + PDF_PAGE_GAP;
        if (first) {
          first = false;
          // Show the first page so the tutor sees where the PDF went.
          const zoom = clampZoom(Math.min(1, (this.width - 80) / PDF_PAGE_WIDTH));
          this.setCamera({ x: area.x + PDF_PAGE_WIDTH / 2 - this.width / 2 / zoom, y: area.y - 40 / zoom, zoom });
        }
        return area;
      },
    };
  }

  /** Places one uploaded PDF page. Returns false if editing is no longer allowed. */
  addPdfPage(
    page: UploadedPage,
    area: { x: number; y: number; w: number; h: number },
    info: { pdfId: string; pdfName: string; pageNumber: number; locked: boolean; ownTab?: boolean },
  ): boolean {
    // Locked pages go into the locked layer, which only hosts can write.
    const model = info.locked || info.ownTab ? this.getWritableLockedModel() : this.getEditableModel();
    if (!model || !this.host) return false;
    let tab: string | undefined;
    if (info.ownTab) {
      const base = info.pdfName.replace(/\.pdf$/i, "").trim() || "PDF";
      const suffix = ` p${info.pageNumber}`;
      tab = model.addTab(`${base.slice(0, 40 - suffix.length)}${suffix}`, info.pdfId, this.pdfTabAfter ?? this.tab);
      const first = this.pdfTabFirst;
      this.pdfTabFirst = false;
      this.pdfTabAfter = tab;
      if (first) {
        // Show the first page's tab, so the tutor sees where the PDF went.
        this.switchTab(tab);
        this.fitView({ tab, x: area.x - 40, y: area.y - 40, w: area.w + 80, h: Math.min(area.h, area.w) + 80 });
      }
    }
    model.addAsset({
      id: page.assetId,
      mime: page.mime,
      width: page.width,
      height: page.height,
      bytes: page.bytes,
      key: page.key,
      url: null,
      dataURL: null,
    });
    model.createItem({
      id: crypto.randomUUID(),
      type: "pdfPage",
      x: area.x,
      y: area.y,
      rotation: 0,
      stroke: "#000000",
      fill: null,
      strokeWidth: 0,
      opacity: 1,
      locked: false,
      assetId: page.assetId,
      w: area.w,
      h: area.h,
      pdfId: info.pdfId,
      pdfName: info.pdfName,
      pageNumber: info.pageNumber,
      ...(tab ? { tab } : {}),
    });
    return true;
  }

  /** Ends a PDF import, so the whole import is one undo step. */
  endPdfImport(): void {
    this.pdfTabAfter = null;
    this.getEditableModel()?.endStep();
    this.getWritableLockedModel()?.endStep();
  }

  zoomIn(): void {
    this.zoomToward(steppedZoom(this.camera.zoom, 1));
  }

  zoomOut(): void {
    this.zoomToward(steppedZoom(this.camera.zoom, -1));
  }

  resetZoom(): void {
    this.zoomToward(1);
  }

  /** Fits everything on the board into view. */
  zoomToContent(): void {
    const items = this.getItems();
    if (items.length === 0) {
      this.setCamera({ x: 0, y: 0, zoom: 1 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const item of items) {
      const b = this.geometryOf(item).bounds;
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    const pad = 40;
    const zoom = clampZoom(
      Math.min(1, (this.width - pad * 2) / Math.max(1, maxX - minX), (this.height - pad * 2) / Math.max(1, maxY - minY)),
    );
    this.setCamera({
      x: (minX + maxX) / 2 - this.width / 2 / zoom,
      y: (minY + maxY) / 2 - this.height / 2 / zoom,
      zoom,
    });
  }

  // ---- ToolHost ----

  getEditableModel(): BoardModel | null {
    return this.isEditable() ? this.model : null;
  }

  getCamera(): Camera {
    return this.camera;
  }

  /** Moves the camera for this person. Ignored while following the tutor. */
  setCamera(camera: Camera): void {
    if (this.follow) return;
    this.placeCamera(camera);
  }

  requestRender(): void {
    if (this.frame !== null || this.destroyed) return;
    this.frame = requestAnimationFrame(this.render);
  }

  getStyle(): DrawStyle {
    return this.style;
  }

  getSelection(): ReadonlySet<string> {
    return this.selection;
  }

  setSelection(ids: Iterable<string>): void {
    this.selection = new Set(ids);
    this.updateSnapshot();
    this.requestRender();
  }

  hitTest(world: Point, radius: number, filter?: (item: BoardItem) => boolean): BoardItem | null {
    const items = this.getItems();
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (filter && !filter(item)) continue;
      if (hitItem(item, this.geometryOf(item), world, radius)) return item;
    }
    return null;
  }

  canSelect(item: BoardItem): boolean {
    return !item.locked || this.host;
  }

  /** Locked items can only be deleted by tutors and admins. */
  private canDelete(item: BoardItem): boolean {
    return !item.locked || this.host;
  }

  itemsTouching(bounds: Bounds): BoardItem[] {
    return this.getItems().filter((item) => itemTouchesBounds(item, this.geometryOf(item), bounds));
  }

  geometryOf(item: BoardItem): ItemGeometry {
    return this.cache.get(item, this.versionOf(item.id));
  }

  /** An item from either layer. Locked-layer items always read as locked. */
  getItem(id: string): BoardItem | undefined {
    return this.layers().byId.get(id)?.item;
  }

  /** Both layers' items, locked layer first (underneath). */
  getItems(): readonly BoardItem[] {
    return this.layers().items;
  }

  private layers(): NonNullable<BoardEngine["combined"]> {
    const main = this.model?.getSortedItems() ?? NO_ITEMS;
    const locked = this.lockedModel?.getSortedItems() ?? NO_ITEMS;
    const tab = this.tab;
    const cached = this.combined;
    if (cached && cached.main === main && cached.locked === locked && cached.tab === tab) return cached;
    const byId = new Map<string, { item: BoardItem; layer: "main" | "locked" }>();
    const items: BoardItem[] = [];
    for (const raw of locked) {
      if (raw.tab !== tab) continue;
      const item = raw.locked ? raw : { ...raw, locked: true };
      items.push(item);
      byId.set(item.id, { item, layer: "locked" });
    }
    for (const item of main) {
      if (item.tab !== tab) continue;
      items.push(item);
      byId.set(item.id, { item, layer: "main" });
    }
    this.combined = { main, locked, tab, items, byId };
    return this.combined;
  }

  /** Every item on every tab, in both layers. */
  private allItems(): BoardItem[] {
    return [...(this.lockedModel?.getSortedItems() ?? NO_ITEMS), ...(this.model?.getSortedItems() ?? NO_ITEMS)];
  }

  /**
   * Deletes tabs with everything on them, plus any other items `alsoDelete`
   * picks (on any tab), from both layers as one undo step.
   */
  private deleteTabsAndItems(tabIds: string[], alsoDelete: (item: BoardItem) => boolean): void {
    const main = this.getEditableModel();
    const locked = this.getWritableLockedModel();
    if (!main || !locked) return;
    const tabs = this.getTabs();
    const doomed = new Set(tabIds);
    if (tabs.every((tab) => doomed.has(tab.id))) {
      // Always keep one tab: empty the last one instead of deleting it.
      const keep = tabs[0].id;
      doomed.delete(keep);
    }
    const pick = (item: BoardItem) => doomed.has(item.tab) || alsoDelete(item);
    const mainIds = main.getSortedItems().filter(pick).map((item) => item.id);
    const lockedIds = locked.getSortedItems().filter(pick).map((item) => item.id);
    if (doomed.has(this.tab)) {
      const index = tabs.findIndex((tab) => tab.id === this.tab);
      const next =
        tabs.slice(index + 1).find((tab) => !doomed.has(tab.id)) ??
        [...tabs.slice(0, index)].reverse().find((tab) => !doomed.has(tab.id));
      if (next) this.switchTab(next.id);
    }
    this.endGesture(true);
    this.history.group(() => {
      if (mainIds.length > 0) main.deleteItems(mainIds);
      if (lockedIds.length > 0) locked.deleteItems(lockedIds);
      if (doomed.size > 0) locked.deleteTabs(doomed);
    });
  }

  private switchTab(id: string): void {
    if (id === this.tab) return;
    this.textEditor.end();
    this.endGesture(true);
    this.tools[this.toolId].hover?.(null);
    this.tabCameras.set(this.tab, this.camera);
    this.tab = id;
    this.model?.setActiveTab(id);
    this.lockedModel?.setActiveTab(id);
    this.combined = null;
    this.selection = new Set();
    this.camera = this.tabCameras.get(id) ?? HOME;
    this.updateSnapshot();
    this.requestRender();
    this.emitView();
  }

  /** Fits a part of the board into view, so all of it shows. */
  private fitView(view: ViewRect): void {
    const zoom = clampZoom(Math.min(this.width / Math.max(1, view.w), this.height / Math.max(1, view.h)));
    this.placeCamera({
      x: view.x + view.w / 2 - this.width / 2 / zoom,
      y: view.y + view.h / 2 - this.height / 2 / zoom,
      zoom,
    });
  }

  private placeCamera(camera: Camera): void {
    this.camera = { ...camera, zoom: clampZoom(camera.zoom) };
    this.updateSnapshot();
    this.requestRender();
    this.emitView();
  }

  private emitView(): void {
    this.options.onView?.(this.getView());
  }

  private layerOf(id: string): "main" | "locked" | null {
    return this.layers().byId.get(id)?.layer ?? null;
  }

  private versionOf(id: string): number {
    return this.layerOf(id) === "locked"
      ? (this.lockedModel?.getItemVersion(id) ?? 0)
      : (this.model?.getItemVersion(id) ?? 0);
  }

  /** The locked layer, when this person may write it: hosts who can edit. */
  private getWritableLockedModel(): BoardModel | null {
    return this.host && this.isEditable() && this.lockedModel?.getSchemaStatus() === "ok"
      ? this.lockedModel
      : null;
  }

  publishLaser(points: Point[] | null): void {
    this.options.onLaser?.(points);
  }

  beginTextEdit(id: string, created: boolean): void {
    if (!this.isEditable()) return;
    this.setSelection([]);
    this.textEditor.begin(id, created);
  }

  // ---- internals ----

  private isEditable(): boolean {
    return this.allowedToEdit && this.model?.getSchemaStatus() === "ok";
  }

  private applyEditability(): void {
    const editable = this.isEditable();
    if (!editable && this.tools[this.toolId].edits) {
      this.textEditor.end();
      this.endGesture(false);
      this.toolId = "hand";
      this.setSelection([]);
    } else if (editable && this.toolId !== this.preferredTool && !this.gesture) {
      this.toolId = this.preferredTool;
    }
    this.updateCursor();
    this.updateSnapshot();
    this.requestRender();
  }

  private onModelChange(): void {
    // The shown tab was deleted (by someone else, or by undo): show another.
    // Only once the tab list (in the locked layer) has loaded.
    const tabsLoaded = this.lockedModel !== null && this.lockedModel.getSchemaStatus() !== "pending";
    const tabs = this.getTabs();
    const followed = this.follow;
    if (!tabsLoaded) {
      // Wait for the locked layer.
    } else if (followed && followed.tab !== this.tab && tabs.some((tab) => tab.id === followed.tab)) {
      // Following the tutor onto a tab that has only just arrived.
      this.switchTab(followed.tab);
      this.fitView(followed);
    } else if (!tabs.some((tab) => tab.id === this.tab)) {
      this.switchTab(tabs[0].id);
    }
    const model = this.model;
    if (!model) {
      this.updateSnapshot();
      return;
    }
    // Editability can change when the schema check finishes.
    if (this.isEditable() !== this.snapshot.editable) this.applyEditability();
    let pruned = false;
    for (const id of this.selection) {
      if (!this.getItem(id)) {
        this.selection.delete(id);
        pruned = true;
      }
    }
    if (pruned) this.selection = new Set(this.selection);
    this.updateSnapshot();
    this.cache.prune((id) => this.getItem(id) !== undefined);
    this.requestRender();
  }

  private zoomToward(zoom: number): void {
    this.setCamera(zoomAt(this.camera, { x: this.width / 2, y: this.height / 2 }, zoom));
  }

  /** Ends whatever gesture is running. `keep` false undoes its writes. */
  private endGesture(keep: boolean): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (gesture?.kind === "tool") {
      if (keep) gesture.tool.finish();
      else gesture.tool.cancel();
    }
    this.updateCursor();
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, options);
    this.cleanups.push(() => target.removeEventListener(type, listener, options));
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    if (this.follow) this.fitView(this.follow);
    else this.emitView();
    this.requestRender();
  }

  private lasersForRender(now: number): LaserTrail[] {
    const trails: LaserTrail[] = [];
    for (const [clientId, laser] of this.remoteLasers) {
      const alpha = laser.active ? 1 : 1 - (now - laser.updatedAt) / LASER_FADE_MS;
      if (alpha <= 0) {
        this.remoteLasers.delete(clientId);
        continue;
      }
      trails.push({ points: laser.points, color: laser.color, alpha });
    }
    return trails;
  }

  private render = (): void => {
    this.frame = null;
    if (this.destroyed) return;
    const tool = this.tools[this.toolId];
    const model = this.model;
    const editingId = this.textEditor.editingId;
    const toolHidden = tool.hiddenIds?.() ?? EMPTY;
    const hidden = editingId ? new Set([...toolHidden, editingId]) : toolHidden;
    const lasers = this.lasersForRender(performance.now());
    renderBoard(this.ctx, {
      camera: this.camera,
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      items: this.getItems(),
      geometryOf: (item, preview) =>
        preview ? this.cache.get(item, null) : this.cache.get(item, this.versionOf(item.id)),
      override: (id) => tool.overrideItem?.(id) ?? null,
      hidden,
      faded: tool.fadedIds?.() ?? EMPTY,
      previews: tool.previewItems?.() ?? [],
      selection: this.selection,
      showHandles: this.toolId === "select" && this.isEditable(),
      cursors: this.cursors,
      lasers,
      image: (assetId) => {
        const asset = model?.getAsset(assetId) ?? this.lockedModel?.getAsset(assetId);
        if (!asset) return null;
        // Stored files need a signed link; Phase 2 images are inline.
        const src = asset.key ? (this.options.assets?.viewUrl(asset.key) ?? null) : asset.dataURL;
        return this.images.get(assetId, src);
      },
      drawOverlay: (ctx) => tool.drawOverlay?.(ctx, this.camera),
    });
    this.textEditor.position();
    this.updateSelectionBar();
    if (tool.isAnimating?.() || lasers.length > 0) this.requestRender();
  };

  private updateSelectionBar(): void {
    const model = this.model;
    const visible =
      model !== null &&
      this.toolId === "select" &&
      this.isEditable() &&
      this.selection.size > 0 &&
      this.gesture === null &&
      this.textEditor.editingId === null;
    if (!visible) {
      this.selectionBar.update({ area: null, showRemovePdf: false, showLock: false, showUnlock: false, containerWidth: this.width });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let deletable = false;
    let pdf = false;
    let lockable = false;
    let unlockable = false;
    for (const id of this.selection) {
      const item = this.getItem(id);
      if (!item) continue;
      if (this.canDelete(item)) deletable = true;
      if (item.type === "pdfPage" && item.pdfId) pdf = true;
      if (item.locked) unlockable = true;
      else lockable = true;
      const b = this.geometryOf(item).bounds;
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    if (!deletable || minX === Infinity) {
      this.selectionBar.update({ area: null, showRemovePdf: false, showLock: false, showUnlock: false, containerWidth: this.width });
      return;
    }
    const z = this.camera.zoom;
    this.selectionBar.update({
      area: {
        x: (minX - this.camera.x) * z,
        y: (minY - this.camera.y) * z,
        w: (maxX - minX) * z,
        h: (maxY - minY) * z,
      },
      showRemovePdf: pdf && this.host,
      showLock: lockable && this.getWritableLockedModel() !== null,
      showUnlock: unlockable && this.host,
      containerWidth: this.width,
    });
  }

  private buildSnapshot(): EngineSnapshot {
    const editable = this.isEditable();
    const highlighter = this.toolId === "highlighter";
    let strokeColor = highlighter ? this.style.highlighter : this.style.stroke;
    let fillColor = this.style.fill;
    let strokeWidth = highlighter ? this.style.highlighterWidth : this.style.strokeWidth;
    let fontSize = this.style.fontSize;
    const [firstSelected] = this.selection;
    const firstId = this.textEditor.editingId ?? firstSelected;
    const first = firstId ? this.getItem(firstId) : undefined;
    if (first) {
      if (!isPicture(first)) strokeColor = first.stroke;
      if (first.type === "rect" || first.type === "ellipse") fillColor = first.fill;
      if (first.type !== "text" && !isPicture(first)) strokeWidth = first.strokeWidth;
      if (first.type === "text") fontSize = first.fontSize;
    }
    return {
      tool: this.toolId,
      editable,
      canUpload: editable && this.allowedToUpload && this.options.assets !== undefined,
      canAddPdf: this.canAddPdf(),
      canUndo: editable && this.history.canUndo(),
      canRedo: editable && this.history.canRedo(),
      zoom: this.camera.zoom,
      selectionCount: this.selection.size,
      schema: this.model?.getSchemaStatus() ?? null,
      strokeColor,
      fillColor,
      strokeWidth,
      fontSize,
      editingText: this.textEditor.editingId !== null,
      tab: this.tab,
      tabs: this.getTabs(),
      canManageTabs: this.canManageTabs(),
      following: this.follow !== null,
    };
  }

  private updateSnapshot(): void {
    const next = this.buildSnapshot();
    const current = this.snapshot;
    const changed = (Object.keys(next) as Array<keyof EngineSnapshot>).some(
      (key) => next[key] !== current[key],
    );
    if (!changed) return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  private updateCursor(): void {
    const panning = this.gesture?.kind === "pan" || this.gesture?.kind === "pinch";
    this.canvas.style.cursor = panning
      ? "grabbing"
      : this.spaceHeld
        ? "grab"
        : this.tools[this.toolId].cursor;
  }

  private toBoardPointer(event: PointerEvent, withSamples: boolean): BoardPointer {
    const rect = this.canvas.getBoundingClientRect();
    const toScreen = (e: PointerEvent) => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const screen = toScreen(event);
    const world = screenToWorld(this.camera, screen);
    // getCoalescedEvents is missing on some older phone browsers.
    const coalesced =
      withSamples && typeof event.getCoalescedEvents === "function"
        ? event.getCoalescedEvents()
        : [];
    const samples = (coalesced.length > 0 ? coalesced : [event]).map((e) => ({
      world: screenToWorld(this.camera, toScreen(e)),
      pressure: e.pressure,
    }));
    return {
      screen,
      world,
      pressure: event.pressure,
      pointerType: event.pointerType,
      shiftKey: event.shiftKey,
      samples,
    };
  }

  private touchPointerIds(): number[] {
    return [...this.pointers.entries()]
      .filter(([, pointer]) => pointer.type === "touch")
      .map(([id]) => id);
  }

  private startPinch(): void {
    const [a, b] = this.touchPointerIds();
    const pa = this.pointers.get(a)?.screen;
    const pb = this.pointers.get(b)?.screen;
    if (!pa || !pb) return;
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    this.gesture = {
      kind: "pinch",
      ids: [a, b],
      startDistance: Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y)),
      anchor: screenToWorld(this.camera, mid),
      startZoom: this.camera.zoom,
    };
    this.updateCursor();
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1) return;
    // A click outside the text being edited only closes the editor.
    if (this.textEditor.editingId) {
      this.textEditor.end();
      this.container.focus({ preventScroll: true });
      return;
    }
    event.preventDefault();
    const pointer = this.toBoardPointer(event, false);
    this.pointers.set(event.pointerId, { screen: pointer.screen, type: event.pointerType });
    this.container.focus({ preventScroll: true });
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the pointer is already gone.
    }
    if (event.pointerType === "pen") this.penSeen = true;

    // A second finger turns any one-finger gesture into pinch and pan.
    if (event.pointerType === "touch" && this.touchPointerIds().length === 2) {
      this.endGesture(false);
      this.startPinch();
      return;
    }
    if (this.gesture) return;

    const panInstead =
      event.button === 1 ||
      this.spaceHeld ||
      (event.pointerType === "touch" && this.penSeen);
    if (panInstead) {
      this.gesture = { kind: "pan", pointerId: event.pointerId, last: pointer.screen };
      this.updateCursor();
      return;
    }
    const tool = this.tools[this.toolId];
    this.gesture = { kind: "tool", pointerId: event.pointerId, tool };
    tool.down(pointer);
    this.updateCursor();
  };

  private onPointerMove = (event: PointerEvent): void => {
    const known = this.pointers.get(event.pointerId);
    const pointer = this.toBoardPointer(event, true);
    if (known) known.screen = pointer.screen;
    if (this.isEditable()) this.options.onCursorMove?.(pointer.world);

    const gesture = this.gesture;
    if (!gesture) {
      this.tools[this.toolId].hover?.(pointer);
      this.updateCursor();
      return;
    }
    if (gesture.kind === "pinch") {
      const pa = this.pointers.get(gesture.ids[0])?.screen;
      const pb = this.pointers.get(gesture.ids[1])?.screen;
      if (!pa || !pb) return;
      const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      const zoom = clampZoom(
        (gesture.startZoom * Math.hypot(pa.x - pb.x, pa.y - pb.y)) / gesture.startDistance,
      );
      this.setCamera({
        x: gesture.anchor.x - mid.x / zoom,
        y: gesture.anchor.y - mid.y / zoom,
        zoom,
      });
      return;
    }
    if (gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "pan") {
      this.setCamera(
        panBy(this.camera, pointer.screen.x - gesture.last.x, pointer.screen.y - gesture.last.y),
      );
      gesture.last = pointer.screen;
      return;
    }
    gesture.tool.move(pointer);
    this.updateCursor();
  };

  private onPointerUp = (event: PointerEvent): void => {
    const gesture = this.gesture;
    this.pointers.delete(event.pointerId);
    if (!gesture) return;
    if (gesture.kind === "pinch") {
      if (gesture.ids.includes(event.pointerId)) this.gesture = null;
    } else if (gesture.pointerId === event.pointerId) {
      this.gesture = null;
      if (gesture.kind === "tool") gesture.tool.up(this.toBoardPointer(event, false));
    }
    this.updateCursor();
  };

  private onPointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    const gesture = this.gesture;
    if (!gesture) return;
    const involved =
      gesture.kind === "pinch"
        ? gesture.ids.includes(event.pointerId)
        : gesture.pointerId === event.pointerId;
    if (involved) this.endGesture(false);
  };

  private onPointerLeave = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" || this.gesture) return;
    this.options.onCursorMove?.(null);
    this.tools[this.toolId].hover?.(null);
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1;
    let dx = event.deltaX * scale;
    const dy = event.deltaY * scale;
    if (event.ctrlKey || event.metaKey) {
      // Trackpad pinch arrives as a ctrl+wheel event.
      const delta = Math.max(-50, Math.min(50, dy));
      const rect = this.canvas.getBoundingClientRect();
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      this.setCamera(zoomAt(this.camera, at, this.camera.zoom * Math.exp(-delta * 0.01)));
      return;
    }
    if (event.shiftKey && dx === 0) dx = dy;
    this.setCamera(panBy(this.camera, -dx, event.shiftKey ? 0 : -dy));
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (event.key === " ") {
      event.preventDefault();
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.updateCursor();
      }
      return;
    }
    if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && key === "y") {
      event.preventDefault();
      this.redo();
      return;
    }
    if (mod && (key === "=" || key === "+")) {
      event.preventDefault();
      this.zoomIn();
      return;
    }
    if (mod && key === "-") {
      event.preventDefault();
      this.zoomOut();
      return;
    }
    if (mod && key === "0") {
      event.preventDefault();
      this.resetZoom();
      return;
    }
    if (mod || event.altKey) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.deleteSelection();
      return;
    }
    if (event.key === "Enter" && this.selection.size === 1) {
      const [id] = this.selection;
      if (this.getItem(id)?.type === "text") {
        event.preventDefault();
        this.beginTextEdit(id, false);
      }
      return;
    }
    if (event.key === "Escape") {
      this.endGesture(false);
      this.setSelection([]);
      return;
    }
    const tool = SHORTCUTS[key];
    if (tool) this.setTool(tool);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === " ") {
      this.spaceHeld = false;
      this.updateCursor();
    }
  };

  private onPaste = (event: ClipboardEvent): void => {
    if (isTypingTarget(event.target) || !this.getEditableModel()) return;
    const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    void this.addImageWithNotice(file);
  };

  private onDragOver = (event: DragEvent): void => {
    if (event.dataTransfer?.types.includes("Files") && this.getEditableModel()) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  };

  private onDrop = (event: DragEvent): void => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!this.getEditableModel() || files.length === 0) return;
    event.preventDefault();
    const pdf = files.find((f) => f.type === "application/pdf");
    if (pdf) {
      this.options.onPdfDropped?.(pdf);
      return;
    }
    const file = files.find((f) => f.type.startsWith("image/"));
    if (!file) return;
    const rect = this.canvas.getBoundingClientRect();
    void this.addImageWithNotice(
      file,
      screenToWorld(this.camera, { x: event.clientX - rect.left, y: event.clientY - rect.top }),
    );
  };

  /** Pasted or dropped images: progress and problems show as a short notice. */
  private async addImageWithNotice(file: Blob, at?: Point): Promise<void> {
    this.options.onNotice?.("Adding image…");
    try {
      await this.insertImage(file, at);
      this.options.onNotice?.("");
    } catch (error) {
      this.options.onNotice?.(
        error instanceof Error && error.message ? error.message : "Could not add that image.",
      );
    }
  }

  private onBlur = (): void => {
    this.spaceHeld = false;
    this.updateCursor();
  };
}
