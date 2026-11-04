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

export type JoinStatus = "waiting" | "admitted" | "denied";

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
}> {
  return request<{ status: JoinStatus; sessionId: string; spaceId: string }>(
    "/join/status",
  );
}

export function leaveSession(sessionId: string): Promise<{ status: "left"; leftAt: string | null }> {
  return request<{ status: "left"; leftAt: string | null }>(
    `/sessions/${encodeURIComponent(sessionId)}/leave`,
    { method: "POST" },
  );
}

export function getLiveKitToken(): Promise<{ token: string; url: string }> {
  return request<{ token: string; url: string }>("/livekit/token", {
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
