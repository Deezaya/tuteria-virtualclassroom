import {
  CircleDot,
  Circle,
  Eraser,
  Highlighter,
  MousePointer2,
  Move,
  MoveUpRight,
  Minus,
  Pencil,
  Redo2,
  Shapes,
  Square,
  Type,
  Undo2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import type { ShapeKind, ToolId } from "../tools/types";

type ToolEntry = { kind: "tool"; id: ToolId; label: string; shortcut: string; icon: LucideIcon; edits: boolean };
type MenuEntry = {
  kind: "shapes";
  label: string;
  icon: LucideIcon;
  tools: Array<{ id: ShapeKind; label: string; shortcut: string; icon: LucideIcon }>;
};
type ActionEntry = {
  kind: "action";
  id: "upload" | "undo" | "redo";
  label: string;
  shortcut?: string;
  icon: LucideIcon;
};

/**
 * One toolbar item. "style" is the colour ring, "zoom" the zoom % button,
 * "size" the line width and text size panel.
 */
export type ToolbarEntry = ToolEntry | MenuEntry | ActionEntry | { kind: "style" } | { kind: "zoom" } | { kind: "size" };

/**
 * Toolbar groups, left to right, in the reference design's order:
 * colour | select, move | pen, highlighter, eraser | shapes, text, laser,
 * upload | undo, redo, zoom | size. Later phases add entries here.
 */
export const TOOLBAR: ToolbarEntry[][] = [
  [{ kind: "style" }],
  [
    { kind: "tool", id: "select", label: "Select", shortcut: "V", icon: MousePointer2, edits: true },
    { kind: "tool", id: "hand", label: "Move around", shortcut: "H", icon: Move, edits: false },
  ],
  [
    { kind: "tool", id: "pen", label: "Pen", shortcut: "P", icon: Pencil, edits: true },
    { kind: "tool", id: "highlighter", label: "Highlighter", shortcut: "M", icon: Highlighter, edits: true },
    { kind: "tool", id: "eraser", label: "Eraser", shortcut: "E", icon: Eraser, edits: true },
  ],
  [
    {
      kind: "shapes",
      label: "Shapes",
      icon: Shapes,
      tools: [
        { id: "rect", label: "Rectangle", shortcut: "R", icon: Square },
        { id: "ellipse", label: "Ellipse", shortcut: "O", icon: Circle },
        { id: "line", label: "Line", shortcut: "L", icon: Minus },
        { id: "arrow", label: "Arrow", shortcut: "A", icon: MoveUpRight },
      ],
    },
    { kind: "tool", id: "text", label: "Text", shortcut: "T", icon: Type, edits: true },
    { kind: "tool", id: "laser", label: "Laser pointer", shortcut: "K", icon: CircleDot, edits: true },
    { kind: "action", id: "upload", label: "Add image", icon: Upload },
  ],
  [
    { kind: "action", id: "undo", label: "Undo", shortcut: "Ctrl+Z", icon: Undo2 },
    { kind: "action", id: "redo", label: "Redo", shortcut: "Ctrl+Shift+Z", icon: Redo2 },
    { kind: "zoom" },
  ],
  [{ kind: "size" }],
];

/** Line colours, as in the reference design. */
export const LINE_COLORS = [
  "#8b5cf6",
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#ec4899",
  "#7c2d12",
  "#1f2937",
  "#ffffff",
];
/** Fill colours; null means no fill. */
export const FILL_COLORS: Array<string | null> = [...LINE_COLORS, null];

export const LINE_WIDTHS = [2, 4, 8, 14];
export const HIGHLIGHTER_WIDTHS = [12, 20, 32, 48];
export const TEXT_SIZES = [
  { label: "S", size: 16 },
  { label: "M", size: 24 },
  { label: "L", size: 36 },
  { label: "XL", size: 56 },
];

export const COLOR_NAMES: Record<string, string> = {
  "#8b5cf6": "Purple",
  "#ef4444": "Red",
  "#f97316": "Orange",
  "#f59e0b": "Yellow",
  "#22c55e": "Green",
  "#06b6d4": "Cyan",
  "#3b82f6": "Blue",
  "#ec4899": "Pink",
  "#7c2d12": "Brown",
  "#1f2937": "Black",
  "#ffffff": "White",
  "#facc15": "Highlighter yellow",
};
