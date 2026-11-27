import type { BoardModel } from "./BoardModel";

type StackEvent = { type: "undo" | "redo" };
type Entry = Set<BoardModel>;

/**
 * One undo history across the board's documents (main and locked layer).
 * Each document keeps its own Y.UndoManager; this records which document(s)
 * each step touched, so Undo always reverts this person's latest step, even
 * when that step changed both (e.g. locking an item moves it between them).
 */
export class BoardHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private readonly detachers = new Map<BoardModel, () => void>();
  private batch: Set<BoardModel> | null = null;
  private replaying = false;
  private readonly listeners = new Set<() => void>();

  attach(model: BoardModel): void {
    if (this.detachers.has(model)) return;
    const onAdded = (event: StackEvent) => this.onAdded(model, event);
    const onPopped = (event: StackEvent) => this.onPopped(model, event);
    model.undoManager.on("stack-item-added", onAdded);
    model.undoManager.on("stack-item-popped", onPopped);
    this.detachers.set(model, () => {
      model.undoManager.off("stack-item-added", onAdded);
      model.undoManager.off("stack-item-popped", onPopped);
    });
  }

  detach(model: BoardModel): void {
    this.detachers.get(model)?.();
    this.detachers.delete(model);
    const without = (stack: Entry[]) =>
      stack.filter((entry) => {
        entry.delete(model);
        return entry.size > 0;
      });
    this.undoStack = without(this.undoStack);
    this.redoStack = without(this.redoStack);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Runs `change` as a single undo step, whichever documents it touches. */
  group(change: () => void): void {
    const models = [...this.detachers.keys()];
    models.forEach((model) => model.endStep());
    const batch = new Set<BoardModel>();
    this.batch = batch;
    try {
      change();
    } finally {
      this.batch = null;
      models.forEach((model) => model.endStep());
      if (batch.size > 0) {
        this.undoStack.push(batch);
        this.redoStack = [];
      }
      this.emit();
    }
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.replay(entry, (model) => model.undoManager.undo());
    this.redoStack.push(entry);
    this.emit();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.replay(entry, (model) => model.undoManager.redo());
    this.undoStack.push(entry);
    this.emit();
  }

  private replay(entry: Entry, action: (model: BoardModel) => void): void {
    this.replaying = true;
    try {
      for (const model of entry) {
        model.endStep();
        action(model);
      }
    } finally {
      this.replaying = false;
    }
  }

  /** A new step in one document (not from our own undo or redo). */
  private onAdded(model: BoardModel, event: StackEvent): void {
    if (this.replaying || event.type !== "undo") return;
    if (this.batch) {
      this.batch.add(model);
      return;
    }
    this.undoStack.push(new Set([model]));
    this.redoStack = [];
    this.emit();
  }

  /**
   * A step removed from a document outside our own undo, i.e. a gesture
   * that was abandoned (BoardModel.discardStep). Forget it here too.
   */
  private onPopped(model: BoardModel, event: StackEvent): void {
    if (this.replaying || event.type !== "undo") return;
    for (let i = this.undoStack.length - 1; i >= 0; i -= 1) {
      const entry = this.undoStack[i];
      if (!entry.has(model)) continue;
      entry.delete(model);
      if (entry.size === 0) this.undoStack.splice(i, 1);
      break;
    }
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}
