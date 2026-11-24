import type { BoardItem } from "../model/schema";
import { worldToScreen, type Camera } from "./camera";
import { rotatePoint, type Point } from "./geometry";
import type { Box, ItemGeometry } from "./items";

export type ResizeHandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type HandleId = ResizeHandleId | "rotate" | "start" | "end";
/** A handle's position on screen. */
export type Handle = { id: HandleId; x: number; y: number };

/** Which way each resize handle points from the box centre. */
export const HANDLE_DIRECTIONS: Record<ResizeHandleId, { hx: -1 | 0 | 1; hy: -1 | 0 | 1 }> = {
  nw: { hx: -1, hy: -1 },
  n: { hx: 0, hy: -1 },
  ne: { hx: 1, hy: -1 },
  e: { hx: 1, hy: 0 },
  se: { hx: 1, hy: 1 },
  s: { hx: 0, hy: 1 },
  sw: { hx: -1, hy: 1 },
  w: { hx: -1, hy: 0 },
};

/** Distance of the rotate handle above the box, in screen pixels. */
const ROTATE_OFFSET_PX = 28;

export function boxCenter(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** The four corners of a box in world space, clockwise from top-left. */
export function boxCorners(box: Box): Point[] {
  const center = boxCenter(box);
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((corner) => rotatePoint(corner, center, box.rotation));
}

function resizeHandlesFor(item: BoardItem): ResizeHandleId[] {
  if (item.type === "text") return ["nw", "ne", "se", "sw", "e", "w"];
  return ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
}

/** Handles shown when exactly this item is selected. */
export function handlesFor(item: BoardItem, geo: ItemGeometry, camera: Camera): Handle[] {
  if (item.locked) return [];
  if (item.type === "line" || item.type === "arrow") {
    const [x1, y1, x2, y2] = item.points;
    const a = worldToScreen(camera, { x: item.x + x1, y: item.y + y1 });
    const b = worldToScreen(camera, { x: item.x + x2, y: item.y + y2 });
    return [
      { id: "start", ...a },
      { id: "end", ...b },
    ];
  }
  const box = geo.box;
  if (!box) return [];
  const center = boxCenter(box);
  const small = box.w * camera.zoom < 24 || box.h * camera.zoom < 24;
  const handles: Handle[] = [];
  for (const id of resizeHandlesFor(item)) {
    const { hx, hy } = HANDLE_DIRECTIONS[id];
    if (small && (hx === 0 || hy === 0)) continue;
    const world = rotatePoint(
      { x: center.x + (hx * box.w) / 2, y: center.y + (hy * box.h) / 2 },
      center,
      box.rotation,
    );
    handles.push({ id, ...worldToScreen(camera, world) });
  }
  const top = worldToScreen(
    camera,
    rotatePoint({ x: center.x, y: box.y }, center, box.rotation),
  );
  handles.push({
    id: "rotate",
    x: top.x + Math.sin(box.rotation) * ROTATE_OFFSET_PX,
    y: top.y - Math.cos(box.rotation) * ROTATE_OFFSET_PX,
  });
  return handles;
}

/** The handle under a screen point, if any. */
export function handleAt(handles: readonly Handle[], screen: Point, radius: number): Handle | null {
  for (const handle of handles) {
    if (Math.hypot(handle.x - screen.x, handle.y - screen.y) <= radius) return handle;
  }
  return null;
}

export function cursorForHandle(id: HandleId, rotation: number): string {
  if (id === "rotate") return "grab";
  if (id === "start" || id === "end") return "crosshair";
  const { hx, hy } = HANDLE_DIRECTIONS[id];
  const angle = (Math.atan2(hy, hx) + rotation) * (180 / Math.PI);
  const normalized = ((Math.round(angle / 45) % 4) + 4) % 4;
  return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][normalized];
}
