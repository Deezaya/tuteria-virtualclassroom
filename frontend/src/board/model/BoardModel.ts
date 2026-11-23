import * as Y from "yjs";
import { isValidKey, keyBetween } from "./fractionalIndex";
import {
  compareItems,
  LEGACY_ROOT_ELEMENTS,
  readItem,
  ROOT_ITEMS,
  ROOT_META,
  SCHEMA_VERSION,
  type BoardItem,
  type ItemMap,
  type StrokeTool,
} from "./schema";

/** Transaction origin for this client's own edits. Undo tracks only these. */
export const LOCAL_ORIGIN = { source: "local-board-edit" };

/**
 * "pending": not synced yet. "ok": version 2 or empty.
 * "legacy": an Excalidraw board. "newer": made by a newer client.
 */
export type SchemaStatus = "pending" | "ok" | "legacy" | "newer";

export type NewStroke = {
  id: string;
  x: number;
  y: number;
  tool: StrokeTool;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  points: number[];
};

type Listener = () => void;

/**
 * The board's Yjs document as plain items, plus every write the engine may
 * make. All writes go through here so undo and origins stay consistent.
 */
export class BoardModel {
  readonly doc: Y.Doc;
  readonly undoManager: Y.UndoManager;
  private readonly meta: Y.Map<unknown>;
  private readonly items: Y.Map<ItemMap>;
  private readonly participantId: string;
  private readonly cache = new Map<string, BoardItem>();
  /** Bumped on every change; lets the renderer cache per-item paths. */
  private readonly versions = new Map<string, number>();
  private sorted: BoardItem[] | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly historyListeners = new Set<Listener>();
  private status: SchemaStatus = "pending";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly onDeepChange: (events: Array<Y.YEvent<any>>) => void;
  private readonly onHistoryChange: () => void;

  constructor(doc: Y.Doc, participantId: string) {
    this.doc = doc;
    this.participantId = participantId;
    this.meta = doc.getMap(ROOT_META);
    this.items = doc.getMap<ItemMap>(ROOT_ITEMS);
    // Gestures call stopCapturing() at their start and end, so one stroke or
    // one move is exactly one undo step however long it takes.
    this.undoManager = new Y.UndoManager(this.items, {
      captureTimeout: Number.MAX_SAFE_INTEGER,
      trackedOrigins: new Set([LOCAL_ORIGIN]),
    });
    this.items.forEach((map, id) => this.refresh(id, map));

    this.onDeepChange = (events) => {
      for (const event of events) {
        if (event.target === this.items) {
          for (const id of event.changes.keys.keys()) this.refresh(id, this.items.get(id));
        } else {
          const id = event.path[0];
          if (typeof id === "string") this.refresh(id, this.items.get(id));
        }
      }
      this.emit();
    };
    this.items.observeDeep(this.onDeepChange);

    this.onHistoryChange = () => this.historyListeners.forEach((listener) => listener());
    this.undoManager.on("stack-item-added", this.onHistoryChange);
    this.undoManager.on("stack-item-popped", this.onHistoryChange);
    this.undoManager.on("stack-cleared", this.onHistoryChange);
  }

  destroy(): void {
    this.items.unobserveDeep(this.onDeepChange);
    this.undoManager.destroy();
    this.listeners.clear();
    this.historyListeners.clear();
  }

  // ---- reading ----

  /** Fires after any change to items, local or remote. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeHistory(listener: Listener): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  getItem(id: string): BoardItem | undefined {
    return this.cache.get(id);
  }

  getItemVersion(id: string): number {
    return this.versions.get(id) ?? 0;
  }

  /** All items in drawing order, bottom first. */
  getSortedItems(): readonly BoardItem[] {
    if (!this.sorted) this.sorted = [...this.cache.values()].sort(compareItems);
    return this.sorted;
  }

  getSchemaStatus(): SchemaStatus {
    return this.status;
  }

  canUndo(): boolean {
    return this.undoManager.canUndo();
  }

  canRedo(): boolean {
    return this.undoManager.canRedo();
  }

  /**
   * Checks the layout version once the document has synced. A client that
   * may write marks an empty board as version 2.
   */
  checkSchema(canWrite: boolean): SchemaStatus {
    const version = this.meta.get("schemaVersion");
    if (typeof version === "number") {
      this.status = version > SCHEMA_VERSION ? "newer" : "ok";
    } else if (this.doc.getMap(LEGACY_ROOT_ELEMENTS).size > 0) {
      this.status = "legacy";
    } else {
      this.status = "ok";
      if (canWrite) {
        this.doc.transact(() => this.meta.set("schemaVersion", SCHEMA_VERSION), LOCAL_ORIGIN);
      }
    }
    this.emit();
    return this.status;
  }

  // ---- writing ----

  /** Ends the current undo step, so the next write starts a new one. */
  endStep(): void {
    this.undoManager.stopCapturing();
  }

  createStroke(stroke: NewStroke): void {
    const map = new Y.Map<unknown>();
    const points = new Y.Array<number>();
    points.push(stroke.points);
    this.doc.transact(() => {
      map.set("type", "stroke");
      map.set("x", stroke.x);
      map.set("y", stroke.y);
      map.set("rotation", 0);
      map.set("z", this.nextZ());
      map.set("createdBy", this.participantId);
      map.set("createdAt", Date.now());
      map.set("stroke", stroke.stroke);
      map.set("fill", null);
      map.set("strokeWidth", stroke.strokeWidth);
      map.set("opacity", stroke.opacity);
      map.set("locked", false);
      map.set("tool", stroke.tool);
      map.set("points", points);
      map.set("done", false);
      this.items.set(stroke.id, map);
    }, LOCAL_ORIGIN);
  }

  /** Adds points to a stroke being drawn. Only the new points are sent. */
  appendStrokePoints(id: string, points: number[], done: boolean): void {
    const map = this.items.get(id);
    if (!map) return;
    this.doc.transact(() => {
      const array = map.get("points");
      if (array instanceof Y.Array && points.length > 0) array.push(points);
      if (done) map.set("done", true);
    }, LOCAL_ORIGIN);
  }

  /** Sets new positions, all in one transaction. */
  moveItems(positions: ReadonlyMap<string, { x: number; y: number }>): void {
    this.doc.transact(() => {
      for (const [id, { x, y }] of positions) {
        const map = this.items.get(id);
        if (!map) continue;
        if (map.get("x") !== x) map.set("x", x);
        if (map.get("y") !== y) map.set("y", y);
      }
    }, LOCAL_ORIGIN);
  }

  deleteItems(ids: Iterable<string>): void {
    this.doc.transact(() => {
      for (const id of ids) this.items.delete(id);
    }, LOCAL_ORIGIN);
  }

  /**
   * Reverts the step in progress and forgets it, so it can't be redone.
   * Used when a gesture is abandoned, e.g. a second finger turns a stroke
   * into a pinch.
   */
  discardStep(): void {
    this.undoManager.stopCapturing();
    this.undoManager.undo();
    this.undoManager.clear(false, true);
  }

  undo(): void {
    this.undoManager.stopCapturing();
    this.undoManager.undo();
  }

  redo(): void {
    this.undoManager.stopCapturing();
    this.undoManager.redo();
  }

  // ---- internals ----

  private nextZ(): string {
    let top: string | null = null;
    for (const item of this.cache.values()) {
      if (isValidKey(item.z) && (top === null || item.z > top)) top = item.z;
    }
    return keyBetween(top, null);
  }

  private refresh(id: string, map: ItemMap | undefined): void {
    const item = map ? readItem(id, map) : null;
    if (item) this.cache.set(id, item);
    else this.cache.delete(id);
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    this.sorted = null;
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}
