import type { BoardProps } from "./types";

/**
 * Placeholder for the custom whiteboard engine. Phase 1 replaces this.
 * It is only loaded when VITE_BOARD_ENGINE=tuteria.
 */
export default function TuteriaWhiteboard(_props: BoardProps) {
  return (
    <div className="classroom-whiteboard-content">
      <div className="classroom-whiteboard-loading">
        The new whiteboard is not built yet. Set VITE_BOARD_ENGINE=excalidraw to use the current board.
      </div>
    </div>
  );
}
