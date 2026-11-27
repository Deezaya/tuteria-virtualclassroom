import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { RemoteLaser, ViewRect } from "../engine/BoardEngine";
import type { Point } from "../engine/geometry";
import { BOARD_COLORS, type RemoteCursor } from "../engine/renderer";
import { DEFAULT_TAB_ID } from "../model/schema";

/**
 * Live presence on a board's main document (awareness, never saved):
 * `user`, `color`, `pid` (participant id), `tab`, `cursor`, `laser`, and
 * `viewport` from the tutor leading in Leading Mode.
 */

/** One colour per person, picked from their participant id. */
export const PERSON_COLORS = [
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Same colour for the same person every time they join. */
export function colorForParticipant(participantId: string): string {
  let hash = 0;
  for (let i = 0; i < participantId.length; i += 1) {
    hash = (hash * 31 + participantId.charCodeAt(i)) | 0;
  }
  return PERSON_COLORS[Math.abs(hash) % PERSON_COLORS.length];
}

function states(provider: HocuspocusProvider | null): Map<number, unknown> {
  return (provider?.awareness?.getStates() as Map<number, unknown> | undefined) ?? new Map();
}

/** Other people's cursors and laser trails on one tab. */
export function readPresence(
  ownClientId: number,
  provider: HocuspocusProvider | null,
  tab: string,
): { cursors: RemoteCursor[]; lasers: RemoteLaser[] } {
  const cursors: RemoteCursor[] = [];
  const lasers: RemoteLaser[] = [];
  for (const [clientId, state] of states(provider)) {
    if (clientId === ownClientId || !isRecord(state)) continue;
    const { user, cursor, color, laser } = state;
    if (!isRecord(user) || user.role === "observer" || typeof user.name !== "string") continue;
    const stateTab = typeof state.tab === "string" ? state.tab : DEFAULT_TAB_ID;
    if (stateTab !== tab) continue;
    const personColor =
      typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)
        ? color
        : PERSON_COLORS[clientId % PERSON_COLORS.length];
    if (isRecord(cursor) && finite(cursor.x) && finite(cursor.y)) {
      cursors.push({ clientId, name: user.name, color: personColor, x: cursor.x, y: cursor.y });
    }
    if (Array.isArray(laser) && laser.length >= 4) {
      const points: Point[] = [];
      for (let i = 0; i + 1 < laser.length; i += 2) {
        const x = laser[i];
        const y = laser[i + 1];
        if (finite(x) && finite(y)) points.push({ x, y });
      }
      lasers.push({ clientId, points, color: BOARD_COLORS.laser });
    }
  }
  return { cursors, lasers };
}

/** The view shared by the person leading, if they are here and sharing it. */
export function findLeaderView(provider: HocuspocusProvider | null, leaderId: string): ViewRect | null {
  for (const state of states(provider).values()) {
    if (!isRecord(state) || state.pid !== leaderId || !isRecord(state.viewport)) continue;
    const { tab, x, y, w, h } = state.viewport;
    if (typeof tab === "string" && finite(x) && finite(y) && finite(w) && finite(h) && w > 0 && h > 0) {
      return { tab, x, y, w, h };
    }
  }
  return null;
}
