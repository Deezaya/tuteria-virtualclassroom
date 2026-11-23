import type { BoardItem } from "../model/schema";

export type Point = { x: number; y: number };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export function boundsFromPoints(a: Point, b: Point): Bounds {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function boundsContainPoint(bounds: Bounds, x: number, y: number): boolean {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

export function expandBounds(bounds: Bounds, by: number): Bounds {
  return {
    minX: bounds.minX - by,
    minY: bounds.minY - by,
    maxX: bounds.maxX + by,
    maxY: bounds.maxY + by,
  };
}

export function unionBounds(list: readonly Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  return list.reduce((acc, b) => ({
    minX: Math.min(acc.minX, b.minX),
    minY: Math.min(acc.minY, b.minY),
    maxX: Math.max(acc.maxX, b.maxX),
    maxY: Math.max(acc.maxY, b.maxY),
  }));
}

/** World-space bounds, including half the stroke width. */
export function itemBounds(item: BoardItem, offset: Point = { x: 0, y: 0 }): Bounds {
  const { points } = item;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  const pad = item.strokeWidth / 2;
  const x = item.x + offset.x;
  const y = item.y + offset.y;
  return { minX: x + minX - pad, minY: y + minY - pad, maxX: x + maxX + pad, maxY: y + maxY + pad };
}

function distanceToSegmentSquared(p: Point, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((p.x - ax) * dx + (p.y - ay) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - p.x;
  const cy = ay + t * dy - p.y;
  return cx * cx + cy * cy;
}

/** True when `point` lies within `radius` of the stroke's line. World units. */
export function strokeHit(
  item: BoardItem,
  point: Point,
  radius: number,
  bounds: Bounds = itemBounds(item),
): boolean {
  const reach = radius + item.strokeWidth / 2;
  if (!boundsContainPoint(expandBounds(bounds, radius), point.x, point.y)) return false;
  const local = { x: point.x - item.x, y: point.y - item.y };
  const { points } = item;
  const reachSquared = reach * reach;
  if (points.length < 6) {
    const dx = (points[0] ?? 0) - local.x;
    const dy = (points[1] ?? 0) - local.y;
    return dx * dx + dy * dy <= reachSquared;
  }
  for (let i = 0; i + 4 < points.length; i += 3) {
    if (
      distanceToSegmentSquared(local, points[i], points[i + 1], points[i + 3], points[i + 4]) <=
      reachSquared
    ) {
      return true;
    }
  }
  return false;
}

/** True when any of the stroke's points lies inside `bounds`. */
export function strokeTouchesBounds(
  item: BoardItem,
  bounds: Bounds,
  ownBounds: Bounds = itemBounds(item),
): boolean {
  if (!boundsIntersect(ownBounds, bounds)) return false;
  const { points } = item;
  for (let i = 0; i + 1 < points.length; i += 3) {
    if (boundsContainPoint(bounds, item.x + points[i], item.y + points[i + 1])) return true;
  }
  return false;
}
