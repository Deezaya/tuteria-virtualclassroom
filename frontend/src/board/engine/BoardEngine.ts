import type { BoardModel, ItemPatch, SchemaStatus } from "../model/BoardModel";
import { BOARD_FONT, isPicture, type BoardItem } from "../model/schema";
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
};

export type StylePatch = Partial<{
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  fontSize: number;
}>;

export type RemoteLaser = { clientId: number; points: Point[]; color: string };

/**
 * Where PDF pages go. "stack": below everything on the board, locked.
 * "view": where the person is looking, movable.
 */
export type PdfPlacement = "stack" | "view";
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
};

type Gesture =
  | { kind: "tool"; pointerId: number; tool: Tool }
  | { kind: "pan"; pointerId: number; last: Point }
  | { kind: "pinch"; ids: [number, number]; startDistance: number; anchor: Point; startZoom: number };

const EMPTY: ReadonlySet<string> = new Set();
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
  private model: BoardModel | null = null;
  private unsubscribeModel: (() => void) | null = null;
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
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
    });
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
    this.model = model;
    this.selection = new Set();
    this.cache.clear();
    this.images.clear();
    if (model) {
      const offChange = model.subscribe(() => this.onModelChange());
      const offHistory = model.subscribeHistory(() => this.updateSnapshot());
      this.unsubscribeModel = () => {
        offChange();
        offHistory();
      };
    }
    this.applyEditability();
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
    const model = this.getEditableModel();
    if (!model) return;
    this.textEditor.end();
    this.endGesture(true);
    model.undo();
  }

  redo(): void {
    const model = this.getEditableModel();
    if (!model) return;
    this.textEditor.end();
    this.endGesture(true);
    model.redo();
  }

  deleteSelection(): void {
    const model = this.getEditableModel();
    if (!model || this.selection.size === 0) return;
    this.endGesture(true);
    const ids = [...this.selection].filter((id) => {
      const item = model.getItem(id);
      return item !== undefined && this.canDelete(item);
    });
    model.endStep();
    model.deleteItems(ids);
    model.endStep();
    this.setSelection([]);
  }

  /** Removes every page of the PDF the selected page came from (tutors and admins). */
  removeSelectedPdf(): void {
    const model = this.getEditableModel();
    if (!model || !this.host) return;
    const page = [...this.selection].map((id) => model.getItem(id)).find((item) => item?.type === "pdfPage");
    if (page?.type !== "pdfPage" || !page.pdfId) return;
    const ids = this.getItems()
      .filter((item) => item.type === "pdfPage" && item.pdfId === page.pdfId)
      .map((item) => item.id);
    const name = page.pdfName || "this PDF";
    if (!window.confirm(`Remove all ${ids.length} page${ids.length === 1 ? "" : "s"} of ${name}? You can undo this.`)) {
      return;
    }
    this.endGesture(true);
    model.endStep();
    model.deleteItems(ids);
    model.endStep();
    this.setSelection([]);
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
    return this.host && this.isEditable() && this.options.assets !== undefined;
  }

  /**
   * Starts a PDF import: works out where each page goes. Pages are
   * PDF_PAGE_WIDTH wide and stacked downwards with a small gap.
   */
  beginPdfImport(placement: PdfPlacement): PdfPlacer {
    this.getEditableModel()?.endStep();
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
    info: { pdfId: string; pdfName: string; pageNumber: number; locked: boolean },
  ): boolean {
    const model = this.getEditableModel();
    if (!model || !this.host) return false;
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
      locked: info.locked,
      assetId: page.assetId,
      w: area.w,
      h: area.h,
      pdfId: info.pdfId,
      pdfName: info.pdfName,
      pageNumber: info.pageNumber,
    });
    return true;
  }

  /** Ends a PDF import, so the whole import is one undo step. */
  endPdfImport(): void {
    this.getEditableModel()?.endStep();
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

  setCamera(camera: Camera): void {
    this.camera = { ...camera, zoom: clampZoom(camera.zoom) };
    this.updateSnapshot();
    this.requestRender();
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
    const version = this.model?.getItemVersion(item.id) ?? null;
    return this.cache.get(item, version);
  }

  getItem(id: string): BoardItem | undefined {
    return this.model?.getItem(id);
  }

  getItems(): readonly BoardItem[] {
    return this.model?.getSortedItems() ?? [];
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
    const model = this.model;
    if (!model) return;
    // Editability can change when the schema check finishes.
    if (this.isEditable() !== this.snapshot.editable) this.applyEditability();
    let pruned = false;
    for (const id of this.selection) {
      if (!model.getItem(id)) {
        this.selection.delete(id);
        pruned = true;
      }
    }
    if (pruned) this.selection = new Set(this.selection);
    this.updateSnapshot();
    this.cache.prune((id) => model.getItem(id) !== undefined);
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
        preview ? this.cache.get(item, null) : this.cache.get(item, model?.getItemVersion(item.id) ?? 0),
      override: (id) => tool.overrideItem?.(id) ?? null,
      hidden,
      faded: tool.fadedIds?.() ?? EMPTY,
      previews: tool.previewItems?.() ?? [],
      selection: this.selection,
      showHandles: this.toolId === "select" && this.isEditable(),
      cursors: this.cursors,
      lasers,
      image: (assetId) => {
        const asset = model?.getAsset(assetId);
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
      this.selectionBar.update({ area: null, showRemovePdf: false, containerWidth: this.width });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let deletable = false;
    let pdf = false;
    for (const id of this.selection) {
      const item = model.getItem(id);
      if (!item) continue;
      if (this.canDelete(item)) deletable = true;
      if (item.type === "pdfPage" && item.pdfId) pdf = true;
      const b = this.geometryOf(item).bounds;
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    if (!deletable || minX === Infinity) {
      this.selectionBar.update({ area: null, showRemovePdf: false, containerWidth: this.width });
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
    const first = firstId ? this.model?.getItem(firstId) : undefined;
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
      canUndo: editable && (this.model?.canUndo() ?? false),
      canRedo: editable && (this.model?.canRedo() ?? false),
      zoom: this.camera.zoom,
      selectionCount: this.selection.size,
      schema: this.model?.getSchemaStatus() ?? null,
      strokeColor,
      fillColor,
      strokeWidth,
      fontSize,
      editingText: this.textEditor.editingId !== null,
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
