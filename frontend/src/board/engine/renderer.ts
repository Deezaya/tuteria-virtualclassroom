import type { BoardItem } from "../model/schema";
import { visibleWorldBounds, worldToScreen, type Camera } from "./camera";
import { boundsIntersect, expandBounds, unionBounds, type Bounds, type Point } from "./geometry";
import { boxCorners, handlesFor } from "./handles";
import { drawItem, type ItemGeometry } from "./items";

export type RemoteCursor = {
  clientId: number;
  name: string;
  color: string;
  x: number;
  y: number;
};

/** A laser trail ready to draw: world points, oldest first. */
export type LaserTrail = { points: Point[]; color: string; alpha: number };

export type RenderInput = {
  camera: Camera;
  width: number;
  height: number;
  dpr: number;
  items: readonly BoardItem[];
  geometryOf: (item: BoardItem, preview: boolean) => ItemGeometry;
  /** Replacement for an item while a tool changes it (move, resize). */
  override: (id: string) => BoardItem | null;
  hidden: ReadonlySet<string>;
  faded: ReadonlySet<string>;
  previews: readonly BoardItem[];
  selection: ReadonlySet<string>;
  showHandles: boolean;
  cursors: readonly RemoteCursor[];
  lasers: readonly LaserTrail[];
  image: (assetId: string) => CanvasImageSource | null;
  /** Screen-space drawing by the active tool (marquee, eraser ring). */
  drawOverlay: (ctx: CanvasRenderingContext2D) => void;
};

/** Colours the engine draws with, in one place for restyling. */
export const BOARD_COLORS = {
  background: "#ffffff",
  grid: "#dde3ee",
  selection: "#0054e5",
  selectionFill: "rgba(0, 84, 229, 0.08)",
  laser: "#ff2d2d",
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

function screenBox(camera: Camera, b: Bounds, pad: number) {
  const a = worldToScreen(camera, { x: b.minX, y: b.minY });
  const c = worldToScreen(camera, { x: b.maxX, y: b.maxY });
  return { x: a.x - pad, y: a.y - pad, w: c.x - a.x + pad * 2, h: c.y - a.y + pad * 2 };
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  selected: Array<{ item: BoardItem; geo: ItemGeometry }>,
  showHandles: boolean,
) {
  if (selected.length === 0) return;
  ctx.save();
  ctx.strokeStyle = BOARD_COLORS.selection;
  ctx.lineWidth = 1.5;

  if (selected.length === 1) {
    const { item, geo } = selected[0];
    if (geo.box) {
      const corners = boxCorners(geo.box).map((corner) => worldToScreen(camera, corner));
      ctx.beginPath();
      corners.forEach((corner, index) =>
        index === 0 ? ctx.moveTo(corner.x, corner.y) : ctx.lineTo(corner.x, corner.y),
      );
      ctx.closePath();
      ctx.stroke();
    } else if (item.type !== "line" && item.type !== "arrow") {
      const r = screenBox(camera, geo.bounds, 4);
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
    }
    if (showHandles) {
      const handles = handlesFor(item, geo, camera);
      const rotate = handles.find((handle) => handle.id === "rotate");
      if (rotate && geo.box) {
        const top = handles.find((handle) => handle.id === "n");
        const corners = boxCorners(geo.box).map((corner) => worldToScreen(camera, corner));
        const from = top ?? { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(rotate.x, rotate.y);
        ctx.stroke();
      }
      for (const handle of handles) {
        ctx.beginPath();
        if (handle.id === "rotate" || handle.id === "start" || handle.id === "end") {
          ctx.arc(handle.x, handle.y, 6, 0, Math.PI * 2);
        } else {
          ctx.rect(handle.x - 5, handle.y - 5, 10, 10);
        }
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
    return;
  }

  ctx.setLineDash([4, 3]);
  for (const { geo } of selected) {
    const r = screenBox(camera, geo.bounds, 4);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
  ctx.setLineDash([]);
  const all = unionBounds(selected.map(({ geo }) => geo.bounds));
  if (all) {
    const r = screenBox(camera, all, 8);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
  ctx.restore();
}

export function drawLaser(ctx: CanvasRenderingContext2D, camera: Camera, trail: LaserTrail) {
  if (trail.points.length === 0 || trail.alpha <= 0) return;
  const screen = trail.points.map((point) => worldToScreen(camera, point));
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = trail.color;
  ctx.shadowColor = trail.color;
  ctx.shadowBlur = 10;
  const count = screen.length;
  for (let i = 1; i < count; i += 1) {
    // Older parts of the trail are thinner and fainter.
    const t = i / count;
    ctx.globalAlpha = trail.alpha * t;
    ctx.lineWidth = 2 + 3 * t;
    ctx.beginPath();
    ctx.moveTo(screen[i - 1].x, screen[i - 1].y);
    ctx.lineTo(screen[i].x, screen[i].y);
    ctx.stroke();
  }
  const head = screen[count - 1];
  ctx.globalAlpha = trail.alpha;
  ctx.fillStyle = trail.color;
  ctx.beginPath();
  ctx.arc(head.x, head.y, 5, 0, Math.PI * 2);
  ctx.fill();
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
  ctx.font = '600 11px "Sora", system-ui, sans-serif';
  const label = cursor.name.length > 24 ? `${cursor.name.slice(0, 23)}…` : cursor.name;
  const width = ctx.measureText(label).width + 14;
  ctx.fillStyle = cursor.color;
  ctx.beginPath();
  // roundRect is missing on some older phone browsers.
  if (typeof ctx.roundRect === "function") ctx.roundRect(12, 18, width, 20, 10);
  else ctx.rect(12, 18, width, 20);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, 19, 32);
  ctx.restore();
}

export function renderBoard(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { camera, width, height, dpr } = input;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = BOARD_COLORS.background;
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, camera, width, height);

  const view = expandBounds(visibleWorldBounds(camera, width, height), 20 / camera.zoom);
  const selected: Array<{ item: BoardItem; geo: ItemGeometry }> = [];
  ctx.setTransform(
    dpr * camera.zoom,
    0,
    0,
    dpr * camera.zoom,
    -camera.x * camera.zoom * dpr,
    -camera.y * camera.zoom * dpr,
  );

  const env = { faded: false, image: input.image };
  const draw = (source: BoardItem, preview: boolean) => {
    const override = preview ? null : input.override(source.id);
    const item = override ?? source;
    const geo = input.geometryOf(item, preview || override !== null);
    if (!preview && input.selection.has(item.id)) selected.push({ item, geo });
    if (!boundsIntersect(geo.bounds, view)) return;
    env.faded = input.faded.has(item.id);
    drawItem(ctx, item, geo, env);
  };

  for (const item of input.items) {
    if (!input.hidden.has(item.id)) draw(item, false);
  }
  for (const preview of input.previews) draw(preview, true);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawSelection(ctx, camera, selected, input.showHandles);
  input.drawOverlay(ctx);
  for (const trail of input.lasers) drawLaser(ctx, camera, trail);
  for (const cursor of input.cursors) drawCursor(ctx, camera, cursor);
}
