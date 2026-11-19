export type ClassRole = "admin" | "tutor" | "student" | "guest" | "observer";

/** Props every whiteboard engine accepts. App.tsx passes exactly these. */
export type BoardProps = {
  canEdit: boolean;
  classRole: ClassRole;
  displayName: string;
  sessionId: string;
  roomId: string | null;
  spyMode: boolean;
};
