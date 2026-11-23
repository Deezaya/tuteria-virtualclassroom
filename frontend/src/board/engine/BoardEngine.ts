import type { BoardModel, SchemaStatus } from "../model/BoardModel";
import type { BoardItem } from "../model/schema";
import { EraserTool } from "../tools/eraserTool";
import { HandTool } from "../tools/handTool";
import { PenTool } from "../tools/penTool";
import { SelectTool } from "../tools/selectTool";
import type { BoardPointer, DrawStyle, Tool, ToolHost, ToolId } from "../tools/types";
import {
  clampZoom,
  panBy,
  screenToWorld,
  steppedZoom,
  zoomAt,
  type Camera,
} from "./camera";
import {
  strokeHit,
  strokeTouchesBounds,
  type Bounds,
  type Point,
} from "./geometry";
import { ItemCache } from "./itemCache";
import { renderBoard, type RemoteCursor } from "./renderer";

export type EngineSnapshot = {
  tool: ToolId;
  editable: boolean;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  selectionCount: number;
  schema: SchemaStatus | null;
};

type EngineOptions = {
  /** World position of this person's pointer, or null when it leaves. */
  onCursorMove?: (world: Point | null) => void;
};

type Gesture =
  | { kind: "tool"; pointerId: number; tool: Tool }
  | { kind: "pan"; pointerId: number; last: Point }
  | { kind: "pinch"; ids: [number, number]; startDistance: number; anchor: Point; startZoom: number };

const EMPTY: ReadonlySet<string> = new Set();

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
  private readonly listeners = new Set<() => void>();
  private readonly pointers = new Map<number, { screen: Point; type: string }>();
  private readonly cleanups: Array<() => void> = [];
  private model: BoardModel | null = null;
  private unsubscribeModel: (() => void) | null = null;
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private allowedToEdit = false;
  private toolId: ToolId = "hand";
  /** The editing tool to return to when editing is allowed again. */
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
  private style: DrawStyle = { stroke: "#1f2937", strokeWidth: 3 };
  private snapshot: EngineSnapshot;
  private destroyed = false;

  constructor(container: HTMLElement, canvas: HTMLCanvasElement, options: EngineOptions = {}) {
    this.container = container;
    this.canvas = canvas;
    this.options = options;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available.");
    this.ctx = ctx;
    this.tools = {
      select: new SelectTool(this),
      hand: new HandTool(this),
      pen: new PenTool(this),
      eraser: new EraserTool(this),
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
    this.listen(container, "keydown", this.onKeyDown);
    this.listen(container, "keyup", this.onKeyUp);
    this.listen(window, "blur", this.onBlur);
    this.resize();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.endGesture(true);
    this.setModel(null);
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.cleanups.forEach((cleanup) => cleanup());
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
    this.endGesture(true);
    this.unsubscribeModel?.();
    this.unsubscribeModel = null;
    this.model = model;
    this.selection = new Set();
    this.cache.clear();
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
    if (!editable) this.endGesture(false);
    this.allowedToEdit = editable;
    this.applyEditability();
  }

  setTool(id: ToolId): void {
    if (this.tools[id].edits && !this.isEditable()) return;
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

  setDrawStyle(style: Partial<DrawStyle>): void {
    this.style = { ...this.style, ...style };
  }

  setRemoteCursors(cursors: RemoteCursor[]): void {
    this.cursors = cursors;
    this.requestRender();
  }

  undo(): void {
    const model = this.getEditableModel();
    if (!model) return;
    this.endGesture(true);
    model.undo();
  }

  redo(): void {
    const model = this.getEditableModel();
    if (!model) return;
    this.endGesture(true);
    model.redo();
  }

  deleteSelection(): void {
    const model = this.getEditableModel();
    if (!model || this.selection.size === 0) return;
    this.endGesture(true);
    const ids = [...this.selection].filter((id) => !model.getItem(id)?.locked);
    model.endStep();
    model.deleteItems(ids);
    model.endStep();
    this.setSelection([]);
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

  hitTest(world: Point, radius: number): BoardItem | null {
    const items = this.getItems();
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (strokeHit(item, world, radius, this.boundsOf(item))) return item;
    }
    return null;
  }

  itemsTouching(bounds: Bounds): BoardItem[] {
    return this.getItems().filter((item) =>
      strokeTouchesBounds(item, bounds, this.boundsOf(item)),
    );
  }

  boundsOf(item: BoardItem): Bounds {
    const version = this.model?.getItemVersion(item.id) ?? null;
    return this.cache.get(item, version).bounds;
  }

  getItems(): readonly BoardItem[] {
    return this.model?.getSortedItems() ?? [];
  }

  // ---- internals ----

  private isEditable(): boolean {
    return this.allowedToEdit && this.model?.getSchemaStatus() === "ok";
  }

  private applyEditability(): void {
    const editable = this.isEditable();
    if (!editable && this.tools[this.toolId].edits) {
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

  private render = (): void => {
    this.frame = null;
    if (this.destroyed) return;
    const tool = this.tools[this.toolId];
    const model = this.model;
    renderBoard(this.ctx, {
      camera: this.camera,
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      items: this.getItems(),
      cache: this.cache,
      versionOf: (id) => model?.getItemVersion(id) ?? 0,
      positionOverride: (id) => tool.positionOverride?.(id) ?? null,
      hidden: tool.hiddenIds?.() ?? EMPTY,
      faded: tool.fadedIds?.() ?? EMPTY,
      previews: tool.previewItems?.() ?? [],
      selection: this.selection,
      cursors: this.cursors,
      drawOverlay: (ctx) => tool.drawOverlay?.(ctx, this.camera),
    });
  };

  private buildSnapshot(): EngineSnapshot {
    return {
      tool: this.toolId,
      editable: this.isEditable(),
      canUndo: this.isEditable() && (this.model?.canUndo() ?? false),
      canRedo: this.isEditable() && (this.model?.canRedo() ?? false),
      zoom: this.camera.zoom,
      selectionCount: this.selection.size,
      schema: this.model?.getSchemaStatus() ?? null,
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
    if (event.key === "Escape") {
      this.endGesture(false);
      this.setSelection([]);
      return;
    }
    const shortcuts: Record<string, ToolId> = { v: "select", h: "hand", p: "pen", e: "eraser" };
    const tool = shortcuts[key];
    if (tool) this.setTool(tool);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === " ") {
      this.spaceHeld = false;
      this.updateCursor();
    }
  };

  private onBlur = (): void => {
    this.spaceHeld = false;
    this.updateCursor();
  };
}
