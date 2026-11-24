export type ClassRole = "admin" | "tutor" | "student" | "guest" | "observer";

/** Props every whiteboard engine accepts. App.tsx passes exactly these. */
export type BoardProps = {
  canEdit: boolean;
  /** May add images and files (the File uploads permission). The Excalidraw board ignores it. */
  canUpload?: boolean;
  classRole: ClassRole;
  displayName: string;
  sessionId: string;
  roomId: string | null;
  spyMode: boolean;
};
