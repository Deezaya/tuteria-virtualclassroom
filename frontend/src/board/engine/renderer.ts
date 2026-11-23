import type { BoardItem } from "../model/schema";
import { visibleWorldBounds, worldToScreen, type Camera } from "./camera";
import { boundsIntersect, expandBounds, unionBounds, type Bounds, type Point } from "./geometry";
import type { ItemCache } from "./itemCache";

export type RemoteCursor = {
  clientId: number;
  name: string;
  color: string;
  x: number;
  y: number;
};

export type RenderInput = {
  camera: Camera;
  width: number;
  height: number;
  dpr: number;
  items: readonly BoardItem[];
  cache: ItemCache;
  versionOf: (id: string) => number;
  positionOverride: (id: string) => Point | null;
  hidden: ReadonlySet<string>;
  faded: ReadonlySet<string>;
  previews: readonly BoardItem[];
  selection: ReadonlySet<string>;
  cursors: readonly RemoteCursor[];
  /** Screen-space drawing by the active tool (marquee, eraser ring). */
  drawOverlay: (ctx: CanvasRenderingContext2D) => void;
};

/** Colours the engine draws with. Phase 2 can restyle these in one place. */
export const BOARD_COLORS = {
  background: "#ffffff",
  grid: "#d7dfef",
  selection: "#0054e5",
  selectionFill: "rgba(0, 84, 229, 0.08)",
};

const GRID_SPACING = 24;

function drawGrid(ctx: CanvasRenderingContext2D, camera: Camera, width: number, height: number) {
  let spacing = GRID_SPACING * camera.zoom;
  while (spacing < 16) spacing *= 2;
  const offsetX = -((camera.x * camera.zoom) % spacing);
  const offsetY = -((camera.y * camera.zoom) % spacing);
  const size = Math.max(1, Math.min(2, camera.zoom * 1.5));
  ctx.beginPath();
  for (let x = offsetX; x < width; x += spacing) {
    for (let y = offsetY; y < height; y += spacing) ctx.rect(x, y, size, size);
  }
  ctx.fillStyle = BOARD_COLORS.grid;
  ctx.fill();
}

function drawItem(
  ctx: CanvasRenderingContext2D,
  item: BoardItem,
  path: Path2D,
  bounds: Bounds,
  offset: Point,
  faded: boolean,
) {
  ctx.save();
  ctx.translate(item.x + offset.x, item.y + offset.y);
  if (item.rotation !== 0) {
    const cx = (bounds.minX + bounds.maxX) / 2 - item.x;
    const cy = (bounds.minY + bounds.maxY) / 2 - item.y;
    ctx.translate(cx, cy);
    ctx.rotate(item.rotation);
    ctx.translate(-cx, -cy);
  }
  ctx.globalAlpha = item.opacity * (faded ? 0.25 : 1);
  ctx.strokeStyle = item.stroke;
  ctx.lineWidth = item.strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(path);
  ctx.restore();
}

function drawSelection(ctx: CanvasRenderingContext2D, camera: Camera, boxes: Bounds[]) {
  if (boxes.length === 0) return;
  const toScreen = (b: Bounds) => {
    const a = worldToScreen(camera, { x: b.minX, y: b.minY });
    const c = worldToScreen(camera, { x: b.maxX, y: b.maxY });
    return { x: a.x - 4, y: a.y - 4, w: c.x - a.x + 8, h: c.y - a.y + 8 };
  };
  ctx.save();
  ctx.strokeStyle = BOARD_COLORS.selection;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  for (const box of boxes) {
    const r = toScreen(box);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
  ctx.setLineDash([]);
  if (boxes.length > 1) {
    const all = unionBounds(boxes);
    if (all) {
      const r = toScreen(all);
      ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
    }
  }
  ctx.restore();
}

function drawCursor(ctx: CanvasRenderingContext2D, camera: Camera, cursor: RemoteCursor) {
  const { x, y } = worldToScreen(camera, cursor);
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 15);
  ctx.lineTo(4, 11);
  ctx.lineTo(7.5, 18);
  ctx.lineTo(10, 17);
  ctx.lineTo(6.5, 10);
  ctx.lineTo(12, 10);
  ctx.closePath();
  ctx.fillStyle = cursor.color;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.font = "600 11px system-ui, sans-serif";
  const label = cursor.name.length > 24 ? `${cursor.name.slice(0, 23)}…` : cursor.name;
  const width = ctx.measureText(label).width + 12;
  ctx.fillStyle = cursor.color;
  ctx.beginPath();
  // roundRect is missing on some older phone browsers.
  if (typeof ctx.roundRect === "function") ctx.roundRect(12, 18, width, 18, 9);
  else ctx.rect(12, 18, width, 18);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, 18, 31);
  ctx.restore();
}

export function renderBoard(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { camera, width, height, dpr } = input;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BOARD_COLORS.background;
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, camera, width, height);

  const view = expandBounds(visibleWorldBounds(camera, width, height), 20 / camera.zoom);
  const selectedBoxes: Bounds[] = [];
  ctx.setTransform(
    dpr * camera.zoom,
    0,
    0,
    dpr * camera.zoom,
    -camera.x * camera.zoom * dpr,
    -camera.y * camera.zoom * dpr,
  );

  const zero = { x: 0, y: 0 };
  const draw = (item: BoardItem, version: number | null) => {
    const override = input.positionOverride(item.id);
    const offset = override ? { x: override.x - item.x, y: override.y - item.y } : zero;
    const entry = input.cache.get(item, version);
    const bounds = {
      minX: entry.bounds.minX + offset.x,
      minY: entry.bounds.minY + offset.y,
      maxX: entry.bounds.maxX + offset.x,
      maxY: entry.bounds.maxY + offset.y,
    };
    if (input.selection.has(item.id)) selectedBoxes.push(bounds);
    if (!boundsIntersect(bounds, view)) return;
    drawItem(ctx, item, entry.path, entry.bounds, offset, input.faded.has(item.id));
  };

  for (const item of input.items) {
    if (!input.hidden.has(item.id)) draw(item, input.versionOf(item.id));
  }
  for (const preview of input.previews) draw(preview, null);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawSelection(ctx, camera, selectedBoxes);
  input.drawOverlay(ctx);
  for (const cursor of input.cursors) drawCursor(ctx, camera, cursor);
}
