import * as Y from "yjs";
import { isValidKey, keyBetween } from "./fractionalIndex";
import {
  compareItems,
  compareTabs,
  DEFAULT_TAB_ID,
  DEFAULT_TAB_NAME,
  LEGACY_ROOT_ELEMENTS,
  MAX_TAB_NAME,
  readAsset,
  readItem,
  readLeading,
  readTab,
  ROOT_ASSETS,
  ROOT_ITEMS,
  ROOT_META,
  ROOT_TABS,
  SCHEMA_VERSION,
  type BoardAsset,
  type BoardItem,
  type BoardTab,
  type ItemMap,
  type Leading,
} from "./schema";

/** Transaction origin for this client's own edits. Undo tracks only these. */
export const LOCAL_ORIGIN = { source: "local-board-edit" };

/**
 * "pending": not synced yet. "ok": version 2 or empty.
 * "legacy": an Excalidraw board. "newer": made by a newer client.
 */
export type SchemaStatus = "pending" | "ok" | "legacy" | "newer";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/**
 * An item as a tool creates it; the model fills in z, createdBy and
 * createdAt, and the tab being shown unless one is given.
 */
export type NewItem = DistributiveOmit<BoardItem, "z" | "createdBy" | "createdAt" | "tab"> & {
  tab?: string;
};
export type ItemPatch = Record<string, unknown>;

/** Keys a patch may never change. */
const FIXED_KEYS = new Set(["id", "type", "z", "createdBy", "createdAt", "text"]);

type Listener = () => void;

/**
 * The board's Yjs document as plain items, plus every write the engine may
 * make. All writes go through here so undo and origins stay consistent.
 */
export class BoardModel {
  readonly doc: Y.Doc;
  readonly undoManager: Y.UndoManager;
  readonly participantId: string;
  private readonly meta: Y.Map<unknown>;
  private readonly items: Y.Map<ItemMap>;
  private readonly assets: Y.Map<Y.Map<unknown>>;
  private readonly tabs: Y.Map<Y.Map<unknown>>;
  private readonly cache = new Map<string, BoardItem>();
  private sortedTabs: BoardTab[] | null = null;
  private leading: Leading | null | undefined = undefined;
  /** New items go on this tab. */
  private activeTab = DEFAULT_TAB_ID;
  /** Bumped on every change; lets the renderer cache per-item geometry. */
  private readonly versions = new Map<string, number>();
  private sorted: BoardItem[] | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly historyListeners = new Set<Listener>();
  private status: SchemaStatus = "pending";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly onDeepChange: (events: Array<Y.YEvent<any>>) => void;
  private readonly onAssetsChange: () => void;
  private readonly onTabsChange: () => void;
  private readonly onMetaChange: () => void;
  private readonly onHistoryChange: () => void;

  constructor(doc: Y.Doc, participantId: string) {
    this.doc = doc;
    this.participantId = participantId;
    this.meta = doc.getMap(ROOT_META);
    this.items = doc.getMap<ItemMap>(ROOT_ITEMS);
    this.assets = doc.getMap<Y.Map<unknown>>(ROOT_ASSETS);
    this.tabs = doc.getMap<Y.Map<unknown>>(ROOT_TABS);
    // Gestures call endStep() at their start and end, so one stroke or one
    // move is exactly one undo step however long it takes.
    this.undoManager = new Y.UndoManager([this.items, this.tabs], {
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

    this.onAssetsChange = () => this.emit();
    this.assets.observeDeep(this.onAssetsChange);

    this.onTabsChange = () => {
      this.sortedTabs = null;
      this.emit();
    };
    this.tabs.observeDeep(this.onTabsChange);

    this.onMetaChange = () => {
      this.leading = undefined;
      this.emit();
    };
    this.meta.observe(this.onMetaChange);

    this.onHistoryChange = () => this.historyListeners.forEach((listener) => listener());
    this.undoManager.on("stack-item-added", this.onHistoryChange);
    this.undoManager.on("stack-item-popped", this.onHistoryChange);
    this.undoManager.on("stack-cleared", this.onHistoryChange);
  }

  destroy(): void {
    this.items.unobserveDeep(this.onDeepChange);
    this.assets.unobserveDeep(this.onAssetsChange);
    this.tabs.unobserveDeep(this.onTabsChange);
    this.meta.unobserve(this.onMetaChange);
    this.undoManager.destroy();
    this.listeners.clear();
    this.historyListeners.clear();
  }

  // ---- reading ----

  /** Fires after any change to items or assets, local or remote. */
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

  getAsset(id: string): BoardAsset | null {
    const map = this.assets.get(id);
    return map ? readAsset(id, map) : null;
  }

  /**
   * The board's tabs in order. A board with no tab list has one tab,
   * DEFAULT_TAB_ID, which holds every item written before tabs existed.
   */
  getTabs(): readonly BoardTab[] {
    if (!this.sortedTabs) {
      const tabs: BoardTab[] = [];
      this.tabs.forEach((map, id) => tabs.push(readTab(id, map)));
      this.sortedTabs =
        tabs.length > 0
          ? tabs.sort(compareTabs)
          : [{ id: DEFAULT_TAB_ID, name: DEFAULT_TAB_NAME, z: "", pdfId: null }];
    }
    return this.sortedTabs;
  }

  /** Leading Mode: who leads, or null when it is off. */
  getLeading(): Leading | null {
    if (this.leading === undefined) this.leading = readLeading(this.meta.get("leading"));
    return this.leading;
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

  /** The tab new items go on. */
  setActiveTab(tab: string): void {
    this.activeTab = tab;
  }

  /** Adds a tab (after `after`, or at the end) and returns its id. */
  addTab(name: string, pdfId: string | null = null, after?: string): string {
    const id = crypto.randomUUID();
    const map = new Y.Map<unknown>();
    this.doc.transact(() => {
      this.materializeTabs();
      const tabs = this.getTabs();
      const index = after ? tabs.findIndex((tab) => tab.id === after) : -1;
      const before = index >= 0 ? tabs[index] : tabs[tabs.length - 1];
      const next = index >= 0 ? tabs[index + 1] : undefined;
      const low = before && isValidKey(before.z) ? before.z : null;
      const high = next && isValidKey(next.z) && (low === null || next.z > low) ? next.z : null;
      map.set("name", cleanTabName(name));
      map.set("z", keyBetween(low, high));
      if (pdfId) map.set("pdfId", pdfId);
      map.set("createdBy", this.participantId);
      map.set("createdAt", Date.now());
      this.tabs.set(id, map);
    }, LOCAL_ORIGIN);
    return id;
  }

  renameTab(id: string, name: string): void {
    const clean = cleanTabName(name);
    this.doc.transact(() => {
      this.materializeTabs();
      const map = this.tabs.get(id);
      if (map && map.get("name") !== clean) map.set("name", clean);
    }, LOCAL_ORIGIN);
  }

  /** Removes tabs from the list. Their items are deleted separately. */
  deleteTabs(ids: Iterable<string>): void {
    this.doc.transact(() => {
      this.materializeTabs();
      for (const id of ids) this.tabs.delete(id);
    }, LOCAL_ORIGIN);
  }

  /** Turns Leading Mode on (with who leads) or off. Not part of undo. */
  setLeading(leading: Leading | null): void {
    this.doc.transact(() => {
      if (leading) this.meta.set("leading", { by: leading.by, name: leading.name.slice(0, 80) });
      else this.meta.delete("leading");
    }, LOCAL_ORIGIN);
  }

  /** Ends the current undo step, so the next write starts a new one. */
  endStep(): void {
    this.undoManager.stopCapturing();
  }

  /**
   * Adds an item on top. `origin` keeps the author and time of an item
   * moved here from another document (locking and unlocking).
   */
  createItem(item: NewItem, origin?: { createdBy: string; createdAt: number }): void {
    const map = new Y.Map<unknown>();
    this.doc.transact(() => {
      for (const [key, value] of Object.entries(item)) {
        if (key === "id" || value === undefined) continue;
        if (key === "points" && item.type === "stroke") {
          const points = new Y.Array<number>();
          points.push(value as number[]);
          map.set(key, points);
        } else if (key === "text") {
          map.set(key, new Y.Text(String(value)));
        } else {
          map.set(key, value);
        }
      }
      if (item.tab === undefined) map.set("tab", this.activeTab);
      map.set("z", this.nextZ());
      map.set("createdBy", origin?.createdBy ?? this.participantId);
      map.set("createdAt", origin?.createdAt ?? Date.now());
      this.items.set(item.id, map);
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

  updateItem(id: string, patch: ItemPatch): void {
    this.updateItems(new Map([[id, patch]]));
  }

  /** Applies several patches in one transaction. Unchanged values are skipped. */
  updateItems(patches: ReadonlyMap<string, ItemPatch>): void {
    this.doc.transact(() => {
      for (const [id, patch] of patches) {
        const map = this.items.get(id);
        if (!map) continue;
        const isStroke = map.get("type") === "stroke";
        for (const [key, value] of Object.entries(patch)) {
          if (FIXED_KEYS.has(key) || value === undefined) continue;
          if (key === "points" && isStroke) continue;
          const current = map.get(key);
          if (Array.isArray(value) && Array.isArray(current) && sameNumbers(value, current)) continue;
          if (current !== value) map.set(key, value);
        }
      }
    }, LOCAL_ORIGIN);
  }

  /** Sets new positions, all in one transaction. */
  moveItems(positions: ReadonlyMap<string, { x: number; y: number }>): void {
    this.updateItems(positions as ReadonlyMap<string, ItemPatch>);
  }

  /**
   * Replaces a text item's text with the smallest edit that gets there, so
   * someone else typing in another part of the same text is not lost.
   */
  setText(id: string, value: string): void {
    const text = this.items.get(id)?.get("text");
    if (!(text instanceof Y.Text)) return;
    const current = text.toString();
    if (current === value) return;
    let start = 0;
    while (start < current.length && start < value.length && current[start] === value[start]) {
      start += 1;
    }
    let endCurrent = current.length;
    let endValue = value.length;
    while (endCurrent > start && endValue > start && current[endCurrent - 1] === value[endValue - 1]) {
      endCurrent -= 1;
      endValue -= 1;
    }
    this.doc.transact(() => {
      if (endCurrent > start) text.delete(start, endCurrent - start);
      if (endValue > start) text.insert(start, value.slice(start, endValue));
    }, LOCAL_ORIGIN);
  }

  deleteItems(ids: Iterable<string>): void {
    this.doc.transact(() => {
      for (const id of ids) this.items.delete(id);
    }, LOCAL_ORIGIN);
  }

  /** Recreates an item read from another document, keeping its id and author. */
  importItem(item: BoardItem): void {
    const copy: Record<string, unknown> = { ...item };
    delete copy.z;
    delete copy.createdBy;
    delete copy.createdAt;
    this.createItem(copy as NewItem, { createdBy: item.createdBy, createdAt: item.createdAt });
  }

  /** Copies an asset from another document if this one doesn't have it yet. */
  copyAsset(asset: BoardAsset): void {
    if (this.assets.has(asset.id)) return;
    const map = new Y.Map<unknown>();
    this.doc.transact(() => {
      for (const [key, value] of Object.entries(asset)) {
        if (key !== "id" && value !== undefined) map.set(key, value);
      }
      this.assets.set(asset.id, map);
    }, LOCAL_ORIGIN);
  }

  addAsset(asset: Omit<BoardAsset, "createdBy">): void {
    const map = new Y.Map<unknown>();
    this.doc.transact(() => {
      for (const [key, value] of Object.entries(asset)) {
        if (key !== "id" && value !== undefined) map.set(key, value);
      }
      map.set("createdBy", this.participantId);
      this.assets.set(asset.id, map);
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

  /** Writes the implicit first tab, so the list can change without losing it. */
  private materializeTabs(): void {
    if (this.tabs.size > 0) return;
    const map = new Y.Map<unknown>();
    map.set("name", DEFAULT_TAB_NAME);
    map.set("z", keyBetween(null, null));
    map.set("createdBy", this.participantId);
    map.set("createdAt", Date.now());
    this.tabs.set(DEFAULT_TAB_ID, map);
    this.sortedTabs = null;
  }

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

function cleanTabName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_TAB_NAME) || "Page";
}

function sameNumbers(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
