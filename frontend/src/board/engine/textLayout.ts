import { TEXT_LINE_HEIGHT } from "../model/schema";

export type TextLayout = { lines: string[]; width: number; height: number; lineHeight: number };

let measureContext: CanvasRenderingContext2D | null = null;
const layouts = new Map<string, TextLayout>();
const MAX_CACHED = 500;

export function fontString(fontSize: number, fontFamily: string): string {
  return `500 ${fontSize}px "${fontFamily}", system-ui, -apple-system, "Segoe UI", sans-serif`;
}

function context(): CanvasRenderingContext2D | null {
  if (!measureContext) measureContext = document.createElement("canvas").getContext("2d");
  return measureContext;
}

/** Breaks one paragraph into lines no wider than `maxWidth`. */
function wrap(ctx: CanvasRenderingContext2D, paragraph: string, maxWidth: number): string[] {
  if (paragraph === "") return [""];
  const fits = (value: string) => ctx.measureText(value).width <= maxWidth;
  const tokens = paragraph.split(/(\s+)/).filter((token) => token !== "");
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    if (fits(line + token)) {
      line += token;
      continue;
    }
    if (/^\s+$/.test(token)) {
      // Spaces that would overflow end the line.
      lines.push(line);
      line = "";
      continue;
    }
    if (line !== "") {
      lines.push(line.trimEnd());
      line = "";
    }
    if (fits(token)) {
      line = token;
      continue;
    }
    // A single word wider than the box: break it by characters.
    for (const char of token) {
      if (line !== "" && !fits(line + char)) {
        lines.push(line);
        line = char;
      } else {
        line += char;
      }
    }
  }
  lines.push(line);
  return lines;
}

/**
 * Lays out text the same way for the canvas and the text editor. Width is
 * the wrap width when set, otherwise the widest line.
 */
export function layoutText(
  text: string,
  fontSize: number,
  fontFamily: string,
  wrapWidth: number | null,
): TextLayout {
  const key = `${fontSize}|${fontFamily}|${wrapWidth ?? ""}|${text}`;
  const cached = layouts.get(key);
  if (cached) return cached;
  const lineHeight = fontSize * TEXT_LINE_HEIGHT;
  const ctx = context();
  let lines = text.split("\n");
  let width = fontSize * 0.5;
  if (ctx) {
    ctx.font = fontString(fontSize, fontFamily);
    if (wrapWidth !== null) lines = lines.flatMap((paragraph) => wrap(ctx, paragraph, wrapWidth));
    for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
  }
  const layout = {
    lines,
    width: wrapWidth ?? Math.ceil(width),
    height: Math.max(1, lines.length) * lineHeight,
    lineHeight,
  };
  if (layouts.size >= MAX_CACHED) layouts.clear();
  layouts.set(key, layout);
  return layout;
}

/** Forgets measured layouts, e.g. once the web font has loaded. */
export function clearTextLayouts(): void {
  layouts.clear();
}
