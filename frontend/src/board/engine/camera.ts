import type { Bounds, Point } from "./geometry";

/**
 * The view onto the infinite board. `x` and `y` are the world point shown
 * at the top-left of the screen; `zoom` is screen pixels per world unit.
 * Phase 5 Leading Mode broadcasts this object through awareness.
 */
export type Camera = { x: number; y: number; zoom: number };

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(camera: Camera, point: Point): Point {
  return { x: point.x / camera.zoom + camera.x, y: point.y / camera.zoom + camera.y };
}

export function worldToScreen(camera: Camera, point: Point): Point {
  return { x: (point.x - camera.x) * camera.zoom, y: (point.y - camera.y) * camera.zoom };
}

/** Zooms so the world point under `screenPoint` stays where it is. */
export function zoomAt(camera: Camera, screenPoint: Point, zoom: number): Camera {
  const next = clampZoom(zoom);
  const world = screenToWorld(camera, screenPoint);
  return { x: world.x - screenPoint.x / next, y: world.y - screenPoint.y / next, zoom: next };
}

export function panBy(camera: Camera, dxScreen: number, dyScreen: number): Camera {
  return { ...camera, x: camera.x - dxScreen / camera.zoom, y: camera.y - dyScreen / camera.zoom };
}

/** The next preset zoom level up or down from the current one. */
export function steppedZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ?? MIN_ZOOM;
}

export function visibleWorldBounds(camera: Camera, width: number, height: number): Bounds {
  return {
    minX: camera.x,
    minY: camera.y,
    maxX: camera.x + width / camera.zoom,
    maxY: camera.y + height / camera.zoom,
  };
}
