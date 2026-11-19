import type { ComponentType } from "react";
import type { BoardProps } from "./types";

/**
 * Which whiteboard the classroom shows, chosen at build time with
 * VITE_BOARD_ENGINE. "excalidraw" (the default) is the current board;
 * "tuteria" is the custom engine being built on the whiteboard-rebuild branch.
 */
export type BoardEngine = "excalidraw" | "tuteria";

function readBoardEngine(): BoardEngine {
  const value = import.meta.env.VITE_BOARD_ENGINE?.trim();
  if (!value || value === "excalidraw") return "excalidraw";
  if (value === "tuteria") return "tuteria";
  console.warn(`Unknown VITE_BOARD_ENGINE "${value}". Using "excalidraw".`);
  return "excalidraw";
}

export const boardEngine: BoardEngine = readBoardEngine();

/** Loads only the selected engine's code, so the other is never downloaded. */
export function loadWhiteboard(): Promise<{ default: ComponentType<BoardProps> }> {
  return boardEngine === "tuteria"
    ? import("./TuteriaWhiteboard")
    : import("../Whiteboard");
}
