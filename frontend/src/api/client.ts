const apiUrl = (import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) {
      throw new ApiError("The server returned an invalid response.", response.status);
    }
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "message" in payload &&
      typeof payload.message === "string"
        ? payload.message
        : response.statusText || `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status);
  }

  return payload as T;
}

export type User = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "tutor" | "student";
};

type UserResponse = { user: User };

export type Space = {
  id: string;
  name: string;
  creatorId: string;
  createdAt: string;
  lastUsedAt: string | null;
  peopleInClass: number;
  activeNow: boolean;
};

type SpaceRecord = Pick<
  Space,
  "id" | "name" | "creatorId" | "createdAt" | "lastUsedAt"
>;

export type SpaceSort = "lastUsed" | "nameAsc";
export type SpaceScope = "all" | "mine";

export function getSpaces(options: {
  search?: string;
  sort?: SpaceSort;
  scope?: SpaceScope;
} = {}): Promise<{ spaces: Space[] }> {
  const query = new URLSearchParams();
  if (options.search) query.set("search", options.search);
  if (options.sort) query.set("sort", options.sort);
  if (options.scope) query.set("scope", options.scope);
  const queryString = query.toString();
  const suffix = queryString ? `?${queryString}` : "";
  return request<{ spaces: Space[] }>(`/spaces${suffix}`);
}

export function createSpace(name: string): Promise<{ space: SpaceRecord }> {
  return request<{ space: SpaceRecord }>("/spaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function renameSpace(
  spaceId: string,
  name: string,
): Promise<{ space: Pick<Space, "id" | "name" | "creatorId" | "createdAt" | "lastUsedAt"> }> {
  return request<{
    space: Pick<Space, "id" | "name" | "creatorId" | "createdAt" | "lastUsedAt">;
  }>(`/spaces/${encodeURIComponent(spaceId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function deleteSpace(spaceId: string): Promise<{ message: string }> {
  return request<{ message: string }>(`/spaces/${encodeURIComponent(spaceId)}`, {
    method: "DELETE",
  });
}

export function createSpaceLink(
  spaceId: string,
  kind: "invite" | "observer",
): Promise<{ spaceId: string; link: string; message: string }> {
  return request<{ spaceId: string; link: string; message: string }>(
    `/spaces/${encodeURIComponent(spaceId)}/${kind}-link`,
    { method: "POST" },
  );
}

export function getBoardToken(sessionId: string): Promise<{
  token: string;
  documentName: string;
  expiresIn: number;
}> {
  return request<{
    token: string;
    documentName: string;
    expiresIn: number;
  }>(`/boards/${encodeURIComponent(sessionId)}/token`, { method: "POST" });
}

export type JoinStatus = "waiting" | "admitted" | "denied" | "removed";
export type ClassRole = "admin" | "tutor" | "student" | "guest" | "observer";
export type ClassPermissions = {
  editing: boolean;
  microphone: boolean;
  camera: boolean;
  screenShare: boolean;
  raiseHand: boolean;
  reactions: boolean;
  chat: boolean;
  fileUploads: boolean;
};
export type PermissionKey = keyof ClassPermissions;
export type SessionParticipant = {
  id: string;
  name: string;
  role: Exclude<ClassRole, "observer">;
  permissions: ClassPermissions;
};

export function getSessionParticipants(
  sessionId: string,
): Promise<{ participants: SessionParticipant[]; defaultPermissions: ClassPermissions }> {
  return request<{ participants: SessionParticipant[]; defaultPermissions: ClassPermissions }>(
    `/sessions/${encodeURIComponent(sessionId)}/participants`,
  );
}

export function updateParticipantPermissions(
  sessionId: string,
  participantId: string,
  permissions: Partial<ClassPermissions>,
): Promise<{ participantId: string; permissions: ClassPermissions }> {
  return request<{ participantId: string; permissions: ClassPermissions }>(
    `/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participantId)}/permissions`,
    { method: "PATCH", body: JSON.stringify(permissions) },
  );
}

export function updateEveryonePermissions(
  sessionId: string,
  permissions: Partial<ClassPermissions>,
): Promise<{ permissions: ClassPermissions }> {
  return request<{ permissions: ClassPermissions }>(
    `/sessions/${encodeURIComponent(sessionId)}/permissions`,
    { method: "PATCH", body: JSON.stringify(permissions) },
  );
}

export function manageParticipant(
  sessionId: string,
  participantId: string,
  action: "mute" | "camera-off" | "remove",
): Promise<{ message: string }> {
  return request<{ message: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participantId)}/${action}`,
    { method: "POST" },
  );
}

export type WaitingParticipant = {
  id: string;
  sessionId: string;
  displayName: string | null;
  classRole: ClassRole;
  status: "waiting" | "admitted" | "denied";
  joinedAt: string;
};

export type ChatMessage = {
  id: string;
  senderName: string | null;
  senderRole: ClassRole;
  participantId: string;
  body: string;
  createdAt: string;
};

export function getChatMessages(
  sessionId: string,
  before?: string,
): Promise<{ messages: ChatMessage[] }> {
  const query = new URLSearchParams();
  if (before) query.set("before", before);
  const suffix = query.size ? `?${query.toString()}` : "";
  return request<{ messages: ChatMessage[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/chat${suffix}`,
  );
}

export function sendChatMessage(
  sessionId: string,
  body: string,
): Promise<ChatMessage> {
  return request<ChatMessage>(
    `/sessions/${encodeURIComponent(sessionId)}/chat`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
}

export type SessionRecord = {
  id: string;
  space: { id: string; name: string };
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
  tutorName: string | null;
  participantCount: number;
  status: "live" | "ended";
};

export type AttendanceRecord = {
  role: "admin" | "tutor" | "student" | "guest" | "observer";
  displayName: string;
  randomId: string | null;
  joinedAt: string;
  leftAt: string | null;
};

export function getSessions(options: {
  search?: string;
  spaceId?: string;
  from?: string;
  to?: string;
  limit?: number;
  page?: number;
}): Promise<{
  sessions: SessionRecord[];
  page: number;
  limit: number;
  hasMore: boolean;
}> {
  const query = new URLSearchParams();
  if (options.search) query.set("search", options.search);
  if (options.spaceId) query.set("spaceId", options.spaceId);
  if (options.from) query.set("from", options.from);
  if (options.to) query.set("to", options.to);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.page !== undefined) query.set("page", String(options.page));
  return request<{
    sessions: SessionRecord[];
    page: number;
    limit: number;
    hasMore: boolean;
  }>(`/sessions?${query.toString()}`);
}

export function getSessionAttendance(
  sessionId: string,
): Promise<{ participants: AttendanceRecord[] }> {
  return request<{ participants: AttendanceRecord[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/attendance`,
  );
}

type JoinResponse = {
  session: { id: string; spaceId: string; spaceName: string };
  participant: { id: string; classRole: string; status: JoinStatus };
};

export function resolveInvite(token: string): Promise<{ space: { id: string; name: string } }> {
  return request<{ space: { id: string; name: string } }>("/invites/resolve", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function joinSpace(token: string, name?: string): Promise<JoinResponse> {
  return request<JoinResponse>("/join", {
    method: "POST",
    body: JSON.stringify(name === undefined ? { token } : { token, name }),
  });
}

export function getJoinStatus(): Promise<{
  status: JoinStatus;
  sessionId: string;
  spaceId: string;
  spaceName: string;
  classRole: ClassRole;
}> {
  return request<{
    status: JoinStatus;
    sessionId: string;
    spaceId: string;
    spaceName: string;
    classRole: ClassRole;
  }>(
    "/join/status",
  );
}

export function getJoinEventsUrl(): string {
  return `${apiUrl}/join/events`;
}

export function getWaitingParticipants(
  sessionId: string,
): Promise<{ participants: WaitingParticipant[] }> {
  return request<{ participants: WaitingParticipant[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/waiting`,
  );
}

export function updateWaitingParticipant(
  participantId: string,
  action: "admit" | "deny",
): Promise<{ participant: WaitingParticipant }> {
  return request<{ participant: WaitingParticipant }>(
    `/participants/${encodeURIComponent(participantId)}/${action}`,
    { method: "POST" },
  );
}

export function leaveSession(sessionId: string): Promise<{ status: "left"; leftAt: string | null }> {
  return request<{ status: "left"; leftAt: string | null }>(
    `/sessions/${encodeURIComponent(sessionId)}/leave`,
    { method: "POST" },
  );
}

export function endSession(sessionId: string): Promise<{ message: string }> {
  return request<{ message: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/end`,
    { method: "POST" },
  );
}

export function getLiveKitToken(): Promise<{
  token: string;
  url: string;
  permissions: ClassPermissions;
}> {
  return request<{ token: string; url: string; permissions: ClassPermissions }>("/livekit/token", {
    method: "POST",
  });
}

export function login(email: string, password: string): Promise<UserResponse> {
  return request<UserResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function getCurrentUser(): Promise<UserResponse> {
  return request<UserResponse>("/auth/me");
}

export function logout(): Promise<{ message: string }> {
  return request<{ message: string }>("/auth/logout", { method: "POST" });
}
