/**
 * Everything that differs per item type: measuring, hit-testing and
 * drawing. Phase 3 adds pdfPage here.
 */
import {
  isBoxItem,
  isPicture,
  type BoardItem,
  type BoxItem,
  type LineItem,
  type StrokeItem,
} from "../model/schema";
import {
  boundsContainPoint,
  boundsIntersect,
  boundsOfPoints,
  distanceToSegmentSquared,
  expandBounds,
  rotatePoint,
  type Bounds,
  type Point,
} from "./geometry";
import { fontString, layoutText, type TextLayout } from "./textLayout";

export type Box = { x: number; y: number; w: number; h: number; rotation: number };

export type ItemGeometry = {
  /** World-space bounding box, including stroke width and rotation. */
  bounds: Bounds;
  /** Unrotated box for resizable items, in world space. */
  box: Box | null;
  /** Local-space path (strokes, shapes, lines). */
  path: Path2D | null;
  /** Pressure strokes: one path per width band. */
  widthPaths: Array<{ width: number; path: Path2D }> | null;
  /** Widest half-width of a stroke, for hit-testing. */
  halfWidth: number;
  text: TextLayout | null;
};

export type DrawEnv = {
  faded: boolean;
  image: (assetId: string) => CanvasImageSource | null;
};

/** Width multiplier for a pen pressure between 0 and 1 (0.5 gives 1×). */
export function pressureFactor(pressure: number): number {
  return 0.35 + 1.3 * Math.max(0, Math.min(1, pressure));
}

const MIN_BOX = 1;

// ---- building ----

function boxBounds(box: Box, pad: number): Bounds {
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((corner) => rotatePoint(corner, center, box.rotation));
  return expandBounds(boundsOfPoints(corners), pad);
}

function strokePoints(item: StrokeItem): Point[] {
  const result: Point[] = [];
  for (let i = 0; i + 1 < item.points.length; i += 3) {
    result.push({ x: item.points[i], y: item.points[i + 1] });
  }
  return result;
}

/** Smooth path through the points: quadratic curves between midpoints. */
function smoothPath(points: readonly Point[]): Path2D {
  const path = new Path2D();
  if (points.length === 0) return path;
  path.moveTo(points[0].x, points[0].y);
  if (points.length === 1) {
    // A zero-length line draws nothing; nudge it so a tap leaves a dot.
    path.lineTo(points[0].x + 0.01, points[0].y);
    return path;
  }
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i];
    const next = points[i + 1];
    path.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
  }
  const last = points[points.length - 1];
  path.lineTo(last.x, last.y);
  return path;
}

/**
 * Pressure strokes are cut into the same curve pieces as smoothPath, and
 * pieces of similar width share one path. Round caps hide the joins.
 */
function pressurePaths(item: StrokeItem, points: readonly Point[]): Array<{ width: number; path: Path2D }> {
  const pressures: number[] = [];
  for (let i = 2; i < item.points.length; i += 3) pressures.push(item.points[i]);
  // Average with neighbours so a jittery pen doesn't give a lumpy line.
  const smooth = pressures.map((_, i) => {
    const from = Math.max(0, i - 2);
    const to = Math.min(pressures.length, i + 3);
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += pressures[j];
    return sum / (to - from);
  });
  const bands = new Map<number, Path2D>();
  const add = (pressure: number, build: (path: Path2D) => void) => {
    const band = Math.round(pressureFactor(pressure) / 0.1) * 0.1;
    let path = bands.get(band);
    if (!path) {
      path = new Path2D();
      bands.set(band, path);
    }
    build(path);
  };
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  if (points.length === 2) {
    add((smooth[0] + smooth[1]) / 2, (path) => {
      path.moveTo(points[0].x, points[0].y);
      path.lineTo(points[1].x, points[1].y);
    });
  }
  for (let i = 1; i < points.length - 1; i += 1) {
    const start = i === 1 ? points[0] : mid(points[i - 1], points[i]);
    const end = mid(points[i], points[i + 1]);
    add(smooth[i], (path) => {
      path.moveTo(start.x, start.y);
      path.quadraticCurveTo(points[i].x, points[i].y, end.x, end.y);
    });
  }
  if (points.length > 2) {
    const n = points.length;
    const start = mid(points[n - 2], points[n - 1]);
    add(smooth[n - 1], (path) => {
      path.moveTo(start.x, start.y);
      path.lineTo(points[n - 1].x, points[n - 1].y);
    });
  }
  return [...bands.entries()].map(([band, path]) => ({ width: item.strokeWidth * band, path }));
}

function arrowHeadLength(item: LineItem): number {
  return Math.max(10, item.strokeWidth * 3.5);
}

function linePath(item: LineItem): Path2D {
  const [x1, y1, x2, y2] = item.points;
  const path = new Path2D();
  path.moveTo(x1, y1);
  path.lineTo(x2, y2);
  const length = arrowHeadLength(item);
  const head = (tipX: number, tipY: number, fromX: number, fromY: number) => {
    const angle = Math.atan2(tipY - fromY, tipX - fromX);
    for (const side of [-1, 1]) {
      const a = angle + Math.PI - side * (Math.PI / 7);
      path.moveTo(tipX, tipY);
      path.lineTo(tipX + Math.cos(a) * length, tipY + Math.sin(a) * length);
    }
  };
  if (x1 !== x2 || y1 !== y2) {
    if (item.type === "arrow" && item.arrowEnd) head(x2, y2, x1, y1);
    if (item.type === "arrow" && item.arrowStart) head(x1, y1, x2, y2);
  }
  return path;
}

function shapePath(item: BoxItem, w: number, h: number): Path2D {
  const path = new Path2D();
  if (item.type === "ellipse") {
    path.ellipse(w / 2, h / 2, Math.max(MIN_BOX, w / 2), Math.max(MIN_BOX, h / 2), 0, 0, Math.PI * 2);
  } else if (item.type === "rect" && typeof path.roundRect === "function") {
    path.roundRect(0, 0, w, h, Math.min(8, w / 4, h / 4));
  } else {
    path.rect(0, 0, w, h);
  }
  return path;
}

export function buildGeometry(item: BoardItem): ItemGeometry {
  if (item.type === "stroke") {
    const points = strokePoints(item);
    const pressures: number[] = [];
    for (let i = 2; i < item.points.length; i += 3) pressures.push(item.points[i]);
    const varies =
      item.tool === "pen" &&
      pressures.length > 1 &&
      Math.max(...pressures) - Math.min(...pressures) > 0.05;
    const widthPaths = varies ? pressurePaths(item, points) : null;
    const halfWidth = varies
      ? Math.max(...widthPaths!.map((band) => band.width)) / 2
      : item.strokeWidth / 2;
    const local = boundsOfPoints(points);
    return {
      bounds: expandBounds(
        { minX: local.minX + item.x, minY: local.minY + item.y, maxX: local.maxX + item.x, maxY: local.maxY + item.y },
        halfWidth,
      ),
      box: null,
      path: varies ? null : smoothPath(points),
      widthPaths,
      halfWidth,
      text: null,
    };
  }
  if (item.type === "line" || item.type === "arrow") {
    const [x1, y1, x2, y2] = item.points;
    const pad = item.strokeWidth / 2 + (item.type === "arrow" ? arrowHeadLength(item) : 0);
    return {
      bounds: expandBounds(
        boundsOfPoints([
          { x: item.x + x1, y: item.y + y1 },
          { x: item.x + x2, y: item.y + y2 },
        ]),
        pad,
      ),
      box: null,
      path: linePath(item),
      widthPaths: null,
      halfWidth: item.strokeWidth / 2,
      text: null,
    };
  }
  if (!isBoxItem(item)) {
    return { bounds: boundsOfPoints([]), box: null, path: null, widthPaths: null, halfWidth: 0, text: null };
  }
  let w: number;
  let h: number;
  let text: TextLayout | null = null;
  if (item.type === "text") {
    text = layoutText(item.text, item.fontSize, item.fontFamily, item.w);
    w = text.width;
    h = text.height;
  } else {
    w = Math.max(MIN_BOX, item.w);
    h = Math.max(MIN_BOX, item.h);
  }
  const box = { x: item.x, y: item.y, w, h, rotation: item.rotation };
  const pad = item.type === "rect" || item.type === "ellipse" ? item.strokeWidth / 2 : 0;
  return {
    bounds: boxBounds(box, pad),
    box,
    path: item.type === "rect" || item.type === "ellipse" ? shapePath(item, w, h) : null,
    widthPaths: null,
    halfWidth: item.strokeWidth / 2,
    text,
  };
}

// ---- hit-testing ----

/** The point in the item's own unrotated box space (origin top-left). */
export function toBoxSpace(box: Box, point: Point): Point {
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const local = rotatePoint(point, center, -box.rotation);
  return { x: local.x - box.x, y: local.y - box.y };
}

/** True when `point` is within `radius` world units of the item. */
export function hitItem(item: BoardItem, geo: ItemGeometry, point: Point, radius: number): boolean {
  if (!boundsContainPoint(expandBounds(geo.bounds, radius), point.x, point.y)) return false;
  if (item.type === "stroke") {
    const local = { x: point.x - item.x, y: point.y - item.y };
    const reach = radius + geo.halfWidth;
    const reachSquared = reach * reach;
    const p = item.points;
    if (p.length < 6) {
      const dx = (p[0] ?? 0) - local.x;
      const dy = (p[1] ?? 0) - local.y;
      return dx * dx + dy * dy <= reachSquared;
    }
    for (let i = 0; i + 4 < p.length; i += 3) {
      if (distanceToSegmentSquared(local, p[i], p[i + 1], p[i + 3], p[i + 4]) <= reachSquared) return true;
    }
    return false;
  }
  if (item.type === "line" || item.type === "arrow") {
    const [x1, y1, x2, y2] = item.points;
    const local = { x: point.x - item.x, y: point.y - item.y };
    const reach = radius + item.strokeWidth / 2;
    return distanceToSegmentSquared(local, x1, y1, x2, y2) <= reach * reach;
  }
  const box = geo.box;
  if (!box) return false;
  const local = toBoxSpace(box, point);
  const inside = (pad: number) =>
    local.x >= -pad && local.x <= box.w + pad && local.y >= -pad && local.y <= box.h + pad;
  if (item.type === "text" || isPicture(item)) return inside(radius);
  const edge = radius + item.strokeWidth / 2;
  if (item.type === "rect") {
    if (item.fill) return inside(edge);
    const insideInner =
      local.x > edge && local.x < box.w - edge && local.y > edge && local.y < box.h - edge;
    return inside(edge) && !insideInner;
  }
  // Ellipse.
  const a = Math.max(MIN_BOX, box.w / 2);
  const b = Math.max(MIN_BOX, box.h / 2);
  const dx = local.x - a;
  const dy = local.y - b;
  if (item.fill) return (dx / (a + edge)) ** 2 + (dy / (b + edge)) ** 2 <= 1;
  const d = Math.sqrt((dx / a) ** 2 + (dy / b) ** 2);
  return Math.abs(d - 1) * Math.min(a, b) <= edge;
}

/** True when the item should be picked by a selection box. */
export function itemTouchesBounds(item: BoardItem, geo: ItemGeometry, area: Bounds): boolean {
  if (!boundsIntersect(geo.bounds, area)) return false;
  if (item.type !== "stroke") return true;
  const p = item.points;
  for (let i = 0; i + 1 < p.length; i += 3) {
    if (boundsContainPoint(area, item.x + p[i], item.y + p[i + 1])) return true;
  }
  return false;
}

// ---- drawing ----

export function drawItem(ctx: CanvasRenderingContext2D, item: BoardItem, geo: ItemGeometry, env: DrawEnv): void {
  ctx.save();
  ctx.globalAlpha = item.opacity * (env.faded ? 0.25 : 1);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = item.stroke;

  if (item.type === "stroke") {
    ctx.translate(item.x, item.y);
    if (item.tool === "highlighter") ctx.globalCompositeOperation = "multiply";
    if (geo.widthPaths) {
      for (const band of geo.widthPaths) {
        ctx.lineWidth = band.width;
        ctx.stroke(band.path);
      }
    } else if (geo.path) {
      ctx.lineWidth = item.strokeWidth;
      ctx.stroke(geo.path);
    }
    ctx.restore();
    return;
  }

  if (item.type === "line" || item.type === "arrow") {
    ctx.translate(item.x, item.y);
    ctx.lineWidth = item.strokeWidth;
    if (geo.path) ctx.stroke(geo.path);
    ctx.restore();
    return;
  }

  const box = geo.box;
  if (!box || !isBoxItem(item)) {
    ctx.restore();
    return;
  }
  ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
  if (box.rotation !== 0) ctx.rotate(box.rotation);
  ctx.translate(-box.w / 2, -box.h / 2);

  if (item.type === "rect" || item.type === "ellipse") {
    if (geo.path && item.fill) {
      ctx.fillStyle = item.fill;
      ctx.fill(geo.path);
    }
    if (geo.path && item.strokeWidth > 0) {
      ctx.lineWidth = item.strokeWidth;
      ctx.stroke(geo.path);
    }
  } else if (isPicture(item)) {
    const image = env.image(item.assetId);
    if (image) {
      ctx.drawImage(image, 0, 0, box.w, box.h);
      if (item.type === "pdfPage") {
        // A thin edge so white pages stand out from the white board.
        ctx.strokeStyle = "#d5dbe5";
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, box.w, box.h);
      }
    } else {
      ctx.fillStyle = "#eef2f7";
      ctx.fillRect(0, 0, box.w, box.h);
      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(0, 0, box.w, box.h);
    }
  } else if (item.type === "text" && geo.text) {
    const layout = geo.text;
    ctx.font = fontString(item.fontSize, item.fontFamily);
    ctx.fillStyle = item.stroke;
    ctx.textBaseline = "top";
    ctx.textAlign = item.align;
    const x = item.align === "center" ? box.w / 2 : item.align === "right" ? box.w : 0;
    const inset = (layout.lineHeight - item.fontSize) / 2;
    layout.lines.forEach((line, index) => {
      ctx.fillText(line, x, index * layout.lineHeight + inset);
    });
  }
  ctx.restore();
}
