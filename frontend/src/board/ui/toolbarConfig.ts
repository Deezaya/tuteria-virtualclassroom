import { Eraser, MousePointer2, Move, Pencil, type LucideIcon } from "lucide-react";
import type { ToolId } from "../tools/types";

export type ToolButtonConfig = {
  id: ToolId;
  label: string;
  shortcut: string;
  icon: LucideIcon;
  /** Shown only to people who may edit. */
  edits: boolean;
};

/**
 * Toolbar tool groups, left to right, following the reference design:
 * colour | select, move | pen, highlighter, eraser | shapes, text, equation,
 * … | undo, redo, zoom | settings. Phase 2 adds the colour picker and the
 * other tools by adding entries here; the engine needs no change.
 */
export const TOOL_GROUPS: ToolButtonConfig[][] = [
  [
    { id: "select", label: "Select", shortcut: "V", icon: MousePointer2, edits: true },
    { id: "hand", label: "Move around", shortcut: "H", icon: Move, edits: false },
  ],
  [
    { id: "pen", label: "Pen", shortcut: "P", icon: Pencil, edits: true },
    { id: "eraser", label: "Eraser", shortcut: "E", icon: Eraser, edits: true },
  ],
];
