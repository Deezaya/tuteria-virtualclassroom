/**
 * Connects the Host controls panel (App.tsx) to the board's Leading Mode.
 * The board publishes the current state and how to switch it; the panel
 * shows it and asks to switch it. This file has no board code, so App.tsx
 * can import it without downloading the board.
 */
export type LeadingState = {
  /** The board can switch Leading Mode now: a tutor on the new board, not spying, connected. */
  available: boolean;
  active: boolean;
  /** Who leads, while it is on. */
  leaderName: string | null;
  /** This person is the one leading. */
  byMe: boolean;
};

const UNAVAILABLE: LeadingState = { available: false, active: false, leaderName: null, byMe: false };

let state = UNAVAILABLE;
let owner: object | null = null;
let toggle: (() => void) | null = null;
const listeners = new Set<() => void>();

function set(next: LeadingState): void {
  const same =
    next.available === state.available &&
    next.active === state.active &&
    next.leaderName === state.leaderName &&
    next.byMe === state.byMe;
  if (same) return;
  state = next;
  listeners.forEach((listener) => listener());
}

export const leadingControl = {
  /** For useSyncExternalStore. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** For useSyncExternalStore. */
  getSnapshot(): LeadingState {
    return state;
  },

  /** The board on screen reports its state. `by` identifies that board. */
  publish(by: object, next: LeadingState, onToggle: () => void): void {
    owner = by;
    toggle = onToggle;
    set(next);
  },

  /** The board left the screen. */
  clear(by: object): void {
    if (owner !== by) return;
    owner = null;
    toggle = null;
    set(UNAVAILABLE);
  },

  /** Turns Leading Mode on (led by this tutor) or off. */
  toggle(): void {
    if (state.available) toggle?.();
  },
};
