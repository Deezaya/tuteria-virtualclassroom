/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "excalidraw" (default) or "tuteria". See src/board/engine.ts. */
  readonly VITE_BOARD_ENGINE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
