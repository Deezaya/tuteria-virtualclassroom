import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  isTrackReference,
  useConnectionState,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import {
  Camera,
  CameraOff,
  ChevronDown,
  Eye,
  EyeOff,
  Grid2X2,
  List,
  LogOut,
  Mic,
  MicOff,
  MessageCircle,
  MonitorUp,
  MoreVertical,
  Plus,
  PanelRight,
  PictureInPicture2,
  Search,
  ChevronRight,
  Settings,
  Smile,
  Hand,
  Clock3,
  Crown,
  UsersRound,
  Video,
  Volume2,
  X,
  Wifi,
} from "lucide-react";
import {
  ConnectionState,
  DisconnectReason,
  Track,
  VideoPreset,
  VideoPresets,
  type Participant as LiveKitParticipant,
  type RoomOptions,
} from "livekit-client";
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  ApiError,
  createSpace,
  createSpaceLink,
  deleteSpace,
  endSession,
  getCurrentUser,
  getLiveKitToken,
  getJoinStatus,
  getSessionAttendance,
  getSessions,
  getSpaces,
  joinSpace,
  leaveSession,
  resolveInvite,
  renameSpace,
  type Space,
  type SpaceScope,
  type SpaceSort,
  type AttendanceRecord,
  type SessionRecord,
  type User,
  type ClassRole,
  type WaitingParticipant,
  getWaitingParticipants,
  updateWaitingParticipant,
} from "./api/client";
import { useAuth } from "./auth/AuthProvider";

type RoomMediaPreferences = {
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
  cameraDeviceId: string;
  microphoneDeviceId: string;
  speakerDeviceId: string;
};

let roomMediaPreferences: RoomMediaPreferences = {
  cameraEnabled: true,
  microphoneEnabled: true,
  cameraDeviceId: "",
  microphoneDeviceId: "",
  speakerDeviceId: "",
};

function Logo() {
  return (
    <span className="brand" aria-label="Tuteria">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path
            d="M7.5 5.5h9a1 1 0 0 1 1 1v12l-5.5-3.4-5.5 3.4v-12a1 1 0 0 1 1-1Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span>tuteria</span>
    </span>
  );
}

function Initials({ name }: { name: string }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return <span className="avatar">{initials || "TU"}</span>;
}

function SignInPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const state = location.state as
    | { from?: { pathname?: string; search?: string }; fromJoin?: boolean }
    | null;
  const cameFromJoin =
    state?.fromJoin === true ||
    state?.from?.pathname?.startsWith("/join") === true ||
    new URLSearchParams(location.search).get("from") === "join";

  if (user) {
    const destination = state?.from?.pathname;
    return (
      <Navigate
        to={
          destination?.startsWith("/")
            ? `${destination}${state?.from?.search ?? ""}`
            : "/spaces"
        }
        replace
      />
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(email, password);
      const destination = state?.from?.pathname;
      const destinationUrl = destination?.startsWith("/")
        ? `${destination}${state?.from?.search ?? ""}`
        : "/spaces";
      navigate(destinationUrl, {
        replace: true,
      });
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "Unable to sign in. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="signin-page">
      <header className="signin-brand"><Logo /></header>
      <section className="signin-card" aria-labelledby="signin-heading">
        {cameFromJoin && (
          <button className="back-link" type="button" onClick={() => navigate(-1)}>
            <span aria-hidden="true">‹</span> Back
          </button>
        )}
        <div className="mail-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <path d="m4.5 7 7.5 5.5L19.5 7" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 id="signin-heading">Sign in with email</h1>
        <form className="signin-form" onSubmit={handleSubmit}>
          <label htmlFor="email">Email</label>
          <input
            autoComplete="email"
            id="email"
            name="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            required
            type="email"
            value={email}
          />
          <label htmlFor="password">Password</label>
          <div className="password-input-wrap">
            <input
              autoComplete="current-password"
              id="password"
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Your password"
              required
              type={showPassword ? "text" : "password"}
              value={password}
            />
            <button
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="password-visibility-toggle"
              onClick={() => setShowPassword((visible) => !visible)}
              type="button"
            >
              {showPassword ? <EyeOff aria-hidden="true" size={18} /> : <Eye aria-hidden="true" size={18} />}
            </button>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button signin-submit" disabled={submitting} type="submit">
            {submitting ? "Signing in..." : "Sign in"}
          </button>
        </form>
        <Link className="forgot-link" to="/forgot-password">Forgot password?</Link>
      </section>
      <p className="low-data-note">
        <span aria-hidden="true">⌁</span> Optimised for low-bandwidth connections
      </p>
    </main>
  );
}

function ForgotPasswordPage() {
  return (
    <main className="signin-page">
      <header className="signin-brand"><Logo /></header>
      <section className="signin-card message-card">
        <h1>Password reset</h1>
        <p>Password reset is not available yet. Please contact your classroom administrator for help.</p>
        <Link className="primary-button message-button" to="/sign-in">Back to sign in</Link>
      </section>
    </main>
  );
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) {
    return <Navigate to="/sign-in" replace state={{ from: location }} />;
  }
  return children;
}

function Icon({ name }: { name: "spaces" | "sessions" | "library" | "settings" }) {
  const paths = {
    spaces: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    sessions: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    library: (
      <>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v17H6.5A2.5 2.5 0 0 0 4 22V5.5Z" />
        <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H12v17h5.5A2.5 2.5 0 0 1 20 22V5.5Z" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.7 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.7-1l-1.7.7-1.4-2.4L7.3 15a8 8 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.7-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.7 1l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1-.1 2Z" />
      </>
    ),
  };
  return (
    <svg aria-hidden="true" className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const firstName = user?.name.trim().split(/\s+/)[0] || "there";

  async function handleLogout() {
    setLogoutError("");
    try {
      await logout();
      navigate("/sign-in", { replace: true });
    } catch (cause) {
      setLogoutError(cause instanceof Error ? cause.message : "Unable to log out.");
    }
  }

  const navItems = [
    { to: "/spaces", label: "Spaces", icon: "spaces" as const },
    { to: "/sessions", label: "Sessions", icon: "sessions" as const },
    { to: "/library", label: "Library", icon: "library" as const },
    { to: "/settings", label: "Settings", icon: "settings" as const },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="sidebar-brand" to="/spaces"><Logo /></Link>
        <p className="sidebar-label">WORKSPACE</p>
        <nav className="side-nav" aria-label="Workspace">
          {navItems.map((item) => (
            <NavLink
              className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
              key={item.to}
              to={item.to}
            >
              <Icon name={item.icon} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="low-data-card">
            <span className="sparkle" aria-hidden="true">✧</span>
            <div><strong>Built for low data</strong><p>Audio and boards stay first.</p></div>
          </div>
          <div className="sidebar-profile">
            {user && <Initials name={user.name} />}
            <div className="profile-copy">
              <strong>{user?.name}</strong>
              <span>{user?.role}</span>
            </div>
            <button
              aria-label="Open account menu"
              className="profile-more"
              onClick={() => setMenuOpen((open) => !open)}
              type="button"
            >
              ···
            </button>
          </div>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="welcome">
            <span>Virtual classroom</span>
            <strong>Welcome back, {firstName}</strong>
          </div>
          <div className="account-area">
            <button
              aria-expanded={menuOpen}
              className="account-trigger"
              onClick={() => setMenuOpen((open) => !open)}
              type="button"
            >
              {user && <Initials name={user.name} />}
              <span className="account-role">{user?.role}</span>
              <span aria-hidden="true" className="chevron">›</span>
            </button>
            {menuOpen && (
              <div className="account-menu">
                <strong>{user?.name}</strong>
                <span>{user?.role}</span>
                <button onClick={handleLogout} type="button">Log out</button>
              </div>
            )}
          </div>
        </header>
        <main className="workspace-main">
          {logoutError && <p className="toast-error" role="alert">{logoutError}</p>}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const spaceSymbols = ["x²", "∑", "y=", "√", "π", "△", "f(x)", "∞"];
const spaceColors = ["blue", "orange", "green", "purple"];

function getSpaceAppearance(name: string) {
  let hash = 0;
  for (const character of name.toLowerCase()) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return {
    symbol: spaceSymbols[hash % spaceSymbols.length],
    color: spaceColors[hash % spaceColors.length],
  };
}

function formatLastUsed(value: string | null): string {
  if (!value) return "Not used yet";
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDate = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate();
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (sameDate(date, today)) return `Today, ${time}`;
  if (sameDate(date, yesterday)) return `Yesterday, ${time}`;
  return `${new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(date)}, ${time}`;
}

type SpaceDialog =
  | { kind: "create" }
  | { kind: "rename"; space: Space }
  | { kind: "delete"; space: Space }
  | null;

function SpacesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  const canCreate = isAdmin || user?.role === "tutor";
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SpaceSort>("lastUsed");
  const [scope, setScope] = useState<SpaceScope>("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [reload, setReload] = useState(0);
  const [menuSpaceId, setMenuSpaceId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<SpaceDialog>(null);
  const [dialogName, setDialogName] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [copiedSpaceId, setCopiedSpaceId] = useState<string | null>(null);
  const [busySpaceId, setBusySpaceId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    getSpaces({ search, sort, scope })
      .then(({ spaces: nextSpaces }) => {
        if (active) setSpaces(nextSpaces);
      })
      .catch((cause: unknown) => {
        if (active) {
          setLoadError(
            cause instanceof Error ? cause.message : "Unable to load spaces.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [search, sort, scope, reload]);

  useEffect(() => {
    if (!menuSpaceId) return;
    function closeOnOutside(event: PointerEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setMenuSpaceId(null);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuSpaceId(null);
    }
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuSpaceId]);

  useEffect(() => {
    if (!copiedSpaceId) return;
    const timer = window.setTimeout(() => setCopiedSpaceId(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedSpaceId]);

  function openDialog(nextDialog: SpaceDialog) {
    setDialog(nextDialog);
    setDialogName(nextDialog?.kind === "rename" ? nextDialog.space.name : "");
    setDialogError("");
  }

  async function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog) return;
    setDialogError("");
    setDialogBusy(true);
    try {
      if (dialog.kind === "create") {
        await createSpace(dialogName);
        setDialog(null);
        setReload((count) => count + 1);
      } else if (dialog.kind === "rename") {
        const { space: updated } = await renameSpace(dialog.space.id, dialogName);
        setSpaces((current) =>
          current.map((space) => (space.id === updated.id ? { ...space, ...updated } : space)),
        );
        setDialog(null);
        setReload((count) => count + 1);
      } else {
        await deleteSpace(dialog.space.id);
        setSpaces((current) => current.filter((space) => space.id !== dialog.space.id));
        setDialog(null);
      }
    } catch (cause) {
      setDialogError(cause instanceof Error ? cause.message : "That action could not be completed.");
    } finally {
      setDialogBusy(false);
    }
  }

  async function copySpaceLink(space: Space, kind: "invite" | "observer") {
    setMenuSpaceId(null);
    setActionError("");
    setBusySpaceId(space.id);
    try {
      const { link } = await createSpaceLink(space.id, kind);
      await navigator.clipboard.writeText(link);
      setCopiedSpaceId(space.id);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to copy the link.");
    } finally {
      setBusySpaceId(null);
    }
  }

  async function enterSpace(space: Space) {
    setActionError("");
    setBusySpaceId(space.id);
    try {
      const { link } = await createSpaceLink(space.id, "invite");
      const joinUrl = new URL(link, window.location.origin);
      navigate(`${joinUrl.pathname}${joinUrl.search}`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to open this space.");
    } finally {
      setBusySpaceId(null);
    }
  }

  return (
    <section className="spaces-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR CLASSROOMS</span>
          <h1>Spaces</h1>
          <p>Permanent rooms where your class keeps its boards, files and chat.</p>
        </div>
        {canCreate && (
          <button
            className="primary-button new-space-button"
            onClick={() => openDialog({ kind: "create" })}
            type="button"
          >
            <Plus aria-hidden="true" size={18} /> New space
          </button>
        )}
      </div>
      <div className="notice-card">
        <span className="notice-icon" aria-hidden="true">
          <Icon name="sessions" />
        </span>
        <div>
          <strong>Classes happen whenever you enter a space</strong>
          <p>There is no scheduling in version 1. Share each space&apos;s permanent invite link once and reuse it.</p>
        </div>
      </div>
      <div className="spaces-toolbar">
        <label className="search-box">
          <Search aria-hidden="true" size={17} />
          <input
            aria-label="Search spaces"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search spaces"
            type="search"
            value={searchInput}
          />
        </label>
        <div className="toolbar-actions">
          <label className="select-control">
            <span className="sr-only">Space scope</span>
            <select
              aria-label="Space scope"
              onChange={(event) => setScope(event.target.value as SpaceScope)}
              value={scope}
            >
              <option value="all">All spaces</option>
              <option value="mine">My spaces</option>
            </select>
          </label>
          <label className="select-control">
            <span className="sr-only">Sort spaces</span>
            <select
              aria-label="Sort spaces"
              onChange={(event) => setSort(event.target.value as SpaceSort)}
              value={sort}
            >
              <option value="lastUsed">Last used</option>
              <option value="nameAsc">Name A–Z</option>
            </select>
          </label>
          <div className="view-toggle" aria-label="Space layout">
            <button
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              className={view === "grid" ? "selected" : ""}
              onClick={() => setView("grid")}
              type="button"
            >
              <Grid2X2 aria-hidden="true" size={17} />
            </button>
            <button
              aria-label="List view"
              aria-pressed={view === "list"}
              className={view === "list" ? "selected" : ""}
              onClick={() => setView("list")}
              type="button"
            >
              <List aria-hidden="true" size={17} />
            </button>
          </div>
        </div>
      </div>
      {actionError && <p className="spaces-action-error" role="alert">{actionError}</p>}
      {loading ? (
        <div aria-live="polite" className="spaces-state">Loading spaces...</div>
      ) : loadError ? (
        <div className="spaces-state spaces-state-error" role="alert">
          <p>We couldn&apos;t load your spaces. {loadError}</p>
          <button className="secondary-button" onClick={() => setReload((count) => count + 1)} type="button">
            Try again
          </button>
        </div>
      ) : spaces.length === 0 ? (
        <div className="spaces-state">
          <strong>No spaces yet</strong>
          <p>{search ? "No spaces match your search." : "Create a space to get your classroom started."}</p>
        </div>
      ) : (
        <div className={`space-grid ${view === "list" ? "list-view" : ""}`}>
          {spaces.map((space) => {
            const appearance = getSpaceAppearance(space.name);
            return (
              <article className="space-card" key={space.id}>
                <div className="space-card-head">
                  <div className={`space-symbol ${appearance.color}`}>{appearance.symbol}</div>
                  <div className="space-details">
                    <strong title={space.name}>{space.name}</strong>
                    <span>Last used {formatLastUsed(space.lastUsedAt)}</span>
                  </div>
                </div>
                <div className="space-footer">
                  <span>{space.peopleInClass > 0 ? `${space.peopleInClass} in class` : "Empty"}</span>
                  {space.activeNow && <span className="active-status"><i /> Active now</span>}
                  <button
                    className={`enter-space${space.activeNow ? " enter-primary" : ""}`}
                    disabled={busySpaceId === space.id}
                    onClick={() => void enterSpace(space)}
                    type="button"
                  >
                    <Video aria-hidden="true" size={13} />
                    {busySpaceId === space.id ? "Opening..." : "Enter space"}
                  </button>
                  <div
                    className="space-menu-container"
                    ref={menuSpaceId === space.id ? menuRef : null}
                  >
                    <button
                      aria-expanded={menuSpaceId === space.id}
                      aria-label={`More options for ${space.name}`}
                      className="space-more"
                      disabled={busySpaceId === space.id}
                      onClick={() =>
                        setMenuSpaceId((current) => current === space.id ? null : space.id)
                      }
                      type="button"
                    >
                      <MoreVertical aria-hidden="true" size={17} />
                    </button>
                    {menuSpaceId === space.id && (
                      <div className="space-dropdown" role="menu">
                        <button onClick={() => void copySpaceLink(space, "invite")} role="menuitem" type="button">
                          Copy invite link
                        </button>
                        <button
                          onClick={() => {
                            setMenuSpaceId(null);
                            openDialog({ kind: "rename", space });
                          }}
                          role="menuitem"
                          type="button"
                        >
                          Rename
                        </button>
                        <button onClick={() => void copySpaceLink(space, "observer")} role="menuitem" type="button">
                          Copy observer link
                        </button>
                        {isAdmin && (
                          <button
                            className="delete-menu-item"
                            onClick={() => {
                              setMenuSpaceId(null);
                              openDialog({ kind: "delete", space });
                            }}
                            role="menuitem"
                            type="button"
                          >
                            Delete space
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {copiedSpaceId === space.id && (
                    <span className="copied-message" role="status">Copied</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {dialog && (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !dialogBusy) setDialog(null);
          }}
        >
          <section aria-labelledby="space-dialog-title" aria-modal="true" className="space-dialog" role="dialog">
            {dialog.kind !== "delete" ? (
              <form onSubmit={submitDialog}>
                <span className="eyebrow">{dialog.kind === "create" ? "NEW SPACE" : "EDIT SPACE"}</span>
                <h2 id="space-dialog-title">{dialog.kind === "create" ? "Name your space" : "Rename space"}</h2>
                <input
                  autoFocus
                  maxLength={120}
                  onChange={(event) => setDialogName(event.target.value)}
                  placeholder="e.g. SS3 Physics"
                  required
                  value={dialogName}
                />
                {dialogError && <p className="dialog-error" role="alert">{dialogError}</p>}
                <div className="dialog-actions">
                  <button className="secondary-button" disabled={dialogBusy} onClick={() => setDialog(null)} type="button">
                    Cancel
                  </button>
                  <button className="primary-button" disabled={dialogBusy || !dialogName.trim()} type="submit">
                    {dialogBusy
                      ? "Saving..."
                      : dialog.kind === "create"
                        ? "Create space"
                        : "Save"}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={submitDialog}>
                <span className="eyebrow destructive-eyebrow">DELETE SPACE</span>
                <h2 id="space-dialog-title">Delete {dialog.space.name}?</h2>
                <p className="delete-confirmation">This can’t be undone.</p>
                {dialogError && <p className="dialog-error" role="alert">{dialogError}</p>}
                <div className="dialog-actions">
                  <button className="secondary-button" disabled={dialogBusy} onClick={() => setDialog(null)} type="button">
                    Cancel
                  </button>
                  <button className="destructive-button" disabled={dialogBusy} type="submit">
                    {dialogBusy ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </form>
            )}
            <button
              aria-label="Close dialog"
              className="dialog-close"
              disabled={dialogBusy}
              onClick={() => setDialog(null)}
              type="button"
            >
              <X aria-hidden="true" size={17} />
            </button>
          </section>
        </div>
      )}
    </section>
  );
}

function formatSessionStart(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(minutes: number | null, status: SessionRecord["status"]): string {
  if (status === "live" || minutes === null) return "In progress";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function formatAttendanceTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function SessionsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [tutorName, setTutorName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [attendanceLoading, setAttendanceLoading] = useState(false);
  const [attendanceError, setAttendanceError] = useState("");
  const [reload, setReload] = useState(0);
  const attendanceRequestId = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setSessions([]);
    setExpandedSessionId(null);
    setAttendance([]);
    Promise.all([
      getSessions({ search, spaceId: spaceId || undefined, from: from || undefined, to: to || undefined, limit: 20, page: 1 }),
      getSpaces({ sort: "nameAsc", scope: "all" }),
    ])
      .then(([sessionResult, spaceResult]) => {
        if (!active) return;
        setSessions(sessionResult.sessions);
        setHasMore(sessionResult.hasMore);
        setPage(1);
        setSpaces(spaceResult.spaces);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Unable to load sessions.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [search, spaceId, from, to, reload]);

  const tutorNames = Array.from(
    new Set(sessions.map((session) => session.tutorName).filter((name): name is string => Boolean(name))),
  ).sort((left, right) => left.localeCompare(right));
  const visibleSessions = tutorName
    ? sessions.filter((session) => session.tutorName === tutorName)
    : sessions;

  async function loadMore() {
    const nextPage = page + 1;
    setLoadingMore(true);
    setError("");
    try {
      const result = await getSessions({
        search,
        spaceId: spaceId || undefined,
        from: from || undefined,
        to: to || undefined,
        limit: 20,
        page: nextPage,
      });
      setSessions((current) => [...current, ...result.sessions]);
      setPage(nextPage);
      setHasMore(result.hasMore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load more sessions.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function loadAttendance(sessionId: string) {
    const requestId = ++attendanceRequestId.current;
    setAttendance([]);
    setAttendanceError("");
    setAttendanceLoading(true);
    try {
      const result = await getSessionAttendance(sessionId);
      if (requestId === attendanceRequestId.current) {
        setAttendance(result.participants);
      }
    } catch (cause) {
      if (requestId === attendanceRequestId.current) {
        setAttendanceError(cause instanceof Error ? cause.message : "Unable to load attendance.");
      }
    } finally {
      if (requestId === attendanceRequestId.current) {
        setAttendanceLoading(false);
      }
    }
  }

  async function toggleAttendance(sessionId: string) {
    if (expandedSessionId === sessionId) {
      attendanceRequestId.current += 1;
      setAttendanceLoading(false);
      setExpandedSessionId(null);
      return;
    }
    setExpandedSessionId(sessionId);
    await loadAttendance(sessionId);
  }

  return (
    <section className="sessions-page">
      <div className="sessions-heading">
        <h1>Sessions</h1>
        <p>Every class held in your spaces, newest first.</p>
      </div>
      <div className="sessions-filters">
        <label className="search-box sessions-search">
          <Search aria-hidden="true" size={17} />
          <input
            aria-label="Search space, tutor or learner"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search space, tutor or learner"
            type="search"
            value={searchInput}
          />
        </label>
        <label className="select-control sessions-select">
          <span className="sr-only">Filter by space</span>
          <select
            aria-label="Filter by space"
            onChange={(event) => setSpaceId(event.target.value)}
            value={spaceId}
          >
            <option value="">All spaces</option>
            {spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
          </select>
        </label>
        <label className="select-control sessions-select">
          <span className="sr-only">Filter by tutor</span>
          <select
            aria-label="Filter by tutor"
            onChange={(event) => setTutorName(event.target.value)}
            value={tutorName}
          >
            <option value="">All tutors</option>
            {tutorNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="date-filter">
          <span>From</span>
          <input aria-label="From date" onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        </label>
        <label className="date-filter">
          <span>To</span>
          <input aria-label="To date" onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        </label>
      </div>

      {loading ? (
        <div aria-live="polite" className="sessions-state">Loading sessions...</div>
      ) : error && sessions.length === 0 ? (
        <div className="sessions-state sessions-error" role="alert">
          <p>We couldn’t load sessions. {error}</p>
          <button className="secondary-button" onClick={() => setReload((value) => value + 1)} type="button">Try again</button>
        </div>
      ) : visibleSessions.length === 0 ? (
        <div className="sessions-state">
          <strong>No sessions yet</strong>
          <p>{sessions.length ? "No sessions match these filters." : "Sessions will appear here when classes begin."}</p>
        </div>
      ) : (
        <>
          {error && <p className="sessions-inline-error" role="alert">{error}</p>}
          <div className="session-list">
            {visibleSessions.map((session) => {
              const appearance = getSpaceAppearance(session.space.name);
              const expanded = expandedSessionId === session.id;
              return (
                <article className={`session-item${expanded ? " expanded" : ""}`} key={session.id}>
                  <button
                    aria-expanded={expanded}
                    className="session-row"
                    onClick={() => void toggleAttendance(session.id)}
                    type="button"
                  >
                    <span className={`space-symbol ${appearance.color}`}>{appearance.symbol}</span>
                    <span className="session-space">
                      <strong>{session.space.name}</strong>
                      <span>{formatSessionStart(session.startedAt)}</span>
                    </span>
                    <span className="session-metric session-duration">
                      <span>Duration</span>
                      <strong>{formatDuration(session.durationMinutes, session.status)}</strong>
                    </span>
                    <span className="session-metric session-tutor">
                      <span>Tutor</span>
                      <strong>{session.tutorName ?? "—"}</strong>
                    </span>
                    <span className="session-metric session-participants">
                      <span>Participants</span>
                      <strong>{session.participantCount} {session.participantCount === 1 ? "person" : "people"}</strong>
                    </span>
                    <span className={`session-status ${session.status}`}>
                      {session.status === "live" && <i />}
                      {session.status === "live" ? "Live now" : "Ended"}
                    </span>
                    <ChevronRight aria-hidden="true" className="session-chevron" size={17} />
                  </button>
                  {expanded && (
                    <div className="attendance-panel">
                      <h2>Attendance</h2>
                      {attendanceLoading ? (
                        <p className="attendance-state">Loading attendance...</p>
                      ) : attendanceError ? (
                        <div className="attendance-state attendance-error" role="alert">
                          <span>{attendanceError}</span>
                          <button className="text-button" onClick={() => void loadAttendance(session.id)} type="button">Try again</button>
                        </div>
                      ) : attendance.length === 0 ? (
                        <p className="attendance-state">No attendance recorded.</p>
                      ) : (
                        <div className="attendance-list">
                          <div className="attendance-header">
                            <span>Person</span><span>Role</span><span>Joined</span><span>Left</span>
                          </div>
                          {attendance.map((person, index) => (
                            <div className="attendance-row" key={`${person.role}-${person.randomId ?? person.displayName}-${index}`}>
                              <span className="attendance-person">
                                <strong>{person.displayName}</strong>
                                {isAdmin && person.role === "observer" && person.randomId && (
                                  <code>{person.randomId}</code>
                                )}
                              </span>
                              <span className="attendance-role">{person.role}</span>
                              <span>{formatAttendanceTime(person.joinedAt)}</span>
                              <span>{formatAttendanceTime(person.leftAt)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          {hasMore && (
            <div className="load-more-wrap">
              <button className="secondary-button" disabled={loadingMore} onClick={() => void loadMore()} type="button">
                {loadingMore ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ComingSoonPage({ title }: { title: string }) {
  return (
    <section className="coming-soon">
      <span className="eyebrow">WORKSPACE</span>
      <h1>{title}</h1>
      <p>This page is coming soon.</p>
    </section>
  );
}

function readParticipantRole(participant: LiveKitParticipant): ClassRole | null {
  if (!participant.metadata) return null;
  try {
    const metadata: unknown = JSON.parse(participant.metadata);
    if (typeof metadata !== "object" || metadata === null || !("role" in metadata)) return null;
    const role = metadata.role;
    return role === "admin" || role === "tutor" || role === "student" ||
      role === "guest" || role === "observer"
      ? role
      : null;
  } catch {
    return null;
  }
}

function formatClassRole(role: ClassRole | null): string {
  if (role === "admin") return "Tutor";
  if (role === "tutor") return "Tutor";
  if (role === "student") return "Student";
  if (role === "guest") return "Guest";
  return "Participant";
}

function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase() || "G";
}

const camera144p = new VideoPreset({
  width: 256,
  height: 144,
  maxBitrate: 150_000,
  maxFramerate: 15,
});

const roomTestOptions: RoomOptions = {
  adaptiveStream: true,
  dynacast: true,
  publishDefaults: {
    simulcast: true,
    videoEncoding: camera144p.encoding,
    videoSimulcastLayers: [VideoPresets.h90],
  },
  videoCaptureDefaults: { resolution: camera144p.resolution },
};

function RoomTestPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const joinPath = getJoinPath(location.state);
  const [mediaPreferences] = useState(() => roomMediaPreferences);
  const [credentials, setCredentials] = useState<{
    token: string;
    url: string;
    sessionId: string;
    classRole: ClassRole;
    spaceName: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [roomError, setRoomError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setRoomError("");
    setCredentials(null);

    async function connectToRoom() {
      const [tokenResult, statusResult] = await Promise.allSettled([
        getLiveKitToken(),
        getJoinStatus(),
      ]);
      if (!active) return;

      if (tokenResult.status === "rejected") {
        const cause: unknown = tokenResult.reason;
        if (cause instanceof ApiError && cause.status === 401) {
          setError("You need to join a class first.");
        } else if (cause instanceof ApiError && cause.status === 403) {
          if (statusResult.status === "fulfilled" && statusResult.value.status === "waiting") {
            setError("Waiting to be admitted.");
          } else if (statusResult.status === "fulfilled" && statusResult.value.status === "denied") {
            setError("The tutor didn’t let you in.");
          } else {
            setError("You need to join a class first.");
          }
        } else {
          setError("We couldn’t connect to the class. Check your connection and try again.");
        }
        setLoading(false);
        return;
      }

      if (statusResult.status === "rejected") {
        setError("We couldn’t find your class session. Rejoin using the class invite link.");
        setLoading(false);
        return;
      }

      setCredentials({
        ...tokenResult.value,
        sessionId: statusResult.value.sessionId,
        classRole: statusResult.value.classRole,
        spaceName: statusResult.value.spaceName,
      });
      setLoading(false);
    }

    void connectToRoom();
    return () => {
      active = false;
    };
  }, [attempt]);

  if (loading) {
    return <main className="room-test-page">Connecting to LiveKit...</main>;
  }

  if (error) {
    return (
      <main className="room-test-page">
        <p role="alert">{error}</p>
        <button onClick={() => setAttempt((value) => value + 1)} type="button">Try again</button>
      </main>
    );
  }

  if (!credentials) {
    return <main className="room-test-page">The class session is unavailable.</main>;
  }

  return (
    <main className="room-test-page classroom-room">
      <LiveKitRoom
        audio={mediaPreferences.microphoneEnabled
          ? { deviceId: mediaPreferences.microphoneDeviceId || undefined }
          : false}
        onError={() => setRoomError("We couldn’t connect to the class. Check your connection and try again.")}
        onDisconnected={(reason) => {
          if (reason === DisconnectReason.ROOM_DELETED) {
            navigate("/ended", { replace: true, state: { joinPath } });
          }
        }}
        options={roomTestOptions}
        serverUrl={credentials.url}
        token={credentials.token}
        video={mediaPreferences.cameraEnabled
          ? {
              deviceId: mediaPreferences.cameraDeviceId || undefined,
              resolution: camera144p.resolution,
            }
          : false}
      >
        <RoomAudioRenderer />
        <RoomTestControls
          error={roomError}
          onError={setRoomError}
          classRole={credentials.classRole}
          roomName={credentials.spaceName}
          onLeft={() => {
            navigate("/left", { replace: true, state: { joinPath } });
          }}
          onEnded={() => navigate("/ended", { replace: true, state: { joinPath } })}
          speakerDeviceId={mediaPreferences.speakerDeviceId}
          sessionId={credentials.sessionId}
        />
      </LiveKitRoom>
    </main>
  );
}

function RoomTestControls({
  sessionId,
  onLeft,
  onEnded,
  onError,
  error,
  speakerDeviceId,
  classRole,
  roomName,
}: {
  sessionId: string;
  onLeft: () => void;
  onEnded: () => void;
  onError: (message: string) => void;
  error: string;
  speakerDeviceId: string;
  classRole: ClassRole;
  roomName: string;
}) {
  const connectionState = useConnectionState();
  const cameraTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );
  const screenShareTracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: false });
  const participants = useParticipants();
  const {
    isCameraEnabled,
    isMicrophoneEnabled,
    isScreenShareEnabled,
    localParticipant,
  } = useLocalParticipant();
  const room = useRoomContext();
  const [leaving, setLeaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmEnding, setConfirmEnding] = useState(false);
  const [screenSharePending, setScreenSharePending] = useState(false);
  const [layout, setLayout] = useState<"grid" | "sidebar" | "floating">("grid");
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [waitingGuests, setWaitingGuests] = useState<WaitingParticipant[]>([]);
  const [dismissedGuestIds, setDismissedGuestIds] = useState<Set<string>>(() => new Set());
  const [busyGuestId, setBusyGuestId] = useState<string | null>(null);
  const [waitingError, setWaitingError] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const isHostClassRole = classRole === "admin" || classRole === "tutor";
  const canPublish = classRole !== "observer";
  const visibleParticipants = participants.filter((participant) =>
    readParticipantRole(participant) !== "observer" &&
    !(participant.identity === localParticipant.identity && classRole === "observer"),
  );
  const visibleWaitingGuests = waitingGuests.filter(
    (guest) => !dismissedGuestIds.has(guest.id),
  );
  const currentGuest = visibleWaitingGuests[0];

  useEffect(() => {
    if (!menuOpen) return;
    function closeOnOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [menuOpen]);

  useEffect(() => {
    if (!isHostClassRole) {
      setWaitingGuests([]);
      return;
    }

    let active = true;
    async function pollWaitingGuests() {
      try {
        const result = await getWaitingParticipants(sessionId);
        if (!active) return;
        setWaitingGuests(result.participants);
        setWaitingError("");
      } catch {
        if (active) {
          setWaitingError("We couldn’t check guest requests. Please try again.");
        }
      }
    }

    void pollWaitingGuests();
    const timer = window.setInterval(() => void pollWaitingGuests(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isHostClassRole, sessionId]);

  useEffect(() => {
    if (!speakerDeviceId || connectionState !== ConnectionState.Connected) return;
    void room.switchActiveDevice("audiooutput", speakerDeviceId).catch(() => {
      onError("We couldn’t select that speaker. Your default speaker is still available.");
    });
  }, [connectionState, onError, room, speakerDeviceId]);

  const stateLabel = {
    [ConnectionState.Connecting]: "connecting",
    [ConnectionState.Connected]: "connected",
    [ConnectionState.Reconnecting]: "reconnecting",
    [ConnectionState.SignalReconnecting]: "reconnecting",
    [ConnectionState.Disconnected]: "disconnected",
  }[connectionState] ?? "disconnected";

  async function toggleMicrophone() {
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch {
      onError("We couldn’t change your microphone setting.");
    }
  }

  async function toggleCamera() {
    try {
      await localParticipant.setCameraEnabled(!isCameraEnabled, {
        resolution: camera144p.resolution,
      });
    } catch {
      onError("We couldn’t change your camera setting.");
    }
  }

  async function toggleScreenShare() {
    if (screenSharePending) return;
    setScreenSharePending(true);
    try {
      await localParticipant.setScreenShareEnabled(!isScreenShareEnabled);
    } catch (cause) {
      onError(
        cause instanceof Error && cause.message
          ? `We couldn’t change screen sharing: ${cause.message}`
          : "We couldn’t change screen sharing. Check your browser permissions and try again.",
      );
    } finally {
      setScreenSharePending(false);
    }
  }

  async function respondToGuest(guest: WaitingParticipant, action: "admit" | "deny") {
    setBusyGuestId(guest.id);
    setWaitingError("");
    try {
      await updateWaitingParticipant(guest.id, action);
      setWaitingGuests((current) => current.filter((participant) => participant.id !== guest.id));
      setDismissedGuestIds((current) => new Set(current).add(guest.id));
    } catch {
      setWaitingError(`We couldn’t ${action} this guest. Please try again.`);
    } finally {
      setBusyGuestId(null);
    }
  }

  function dismissGuest(guestId: string) {
    setDismissedGuestIds((current) => new Set(current).add(guestId));
  }

  async function leave() {
    setLeaving(true);
    setMenuOpen(false);
    try {
      await leaveSession(sessionId);
      await room.disconnect();
      onLeft();
    } catch {
      onError("We couldn’t leave the class. Check your connection and try again.");
      setLeaving(false);
    }
  }

  async function endForEveryone() {
    setLeaving(true);
    onError("");
    try {
      await endSession(sessionId);
      setConfirmEnding(false);
      onEnded();
    } catch {
      onError("We couldn’t end the class. Check your connection and try again.");
      setLeaving(false);
    }
  }

  return (
    <section className="classroom-page">
      <header className="classroom-topbar">
        <Logo />
        <button className="classroom-room-tab active" type="button">
          Main room <ChevronDown aria-hidden="true" size={13} />
        </button>
        <button className="classroom-topbar-icon" disabled title="Coming soon" type="button">
          <Plus aria-hidden="true" size={18} />
        </button>
        <span className="classroom-connection-state">{stateLabel}</span>
        <div className="classroom-topbar-spacer" />
        <button className="classroom-record-pill" disabled title="Coming soon" type="button">
          <i /> REC
        </button>
        <button className="classroom-topbar-icon" disabled title="Coming soon" type="button">
          <Crown aria-hidden="true" size={17} />
        </button>
        <button className="classroom-topbar-icon" disabled title="Coming soon" type="button">
          <Clock3 aria-hidden="true" size={17} />
        </button>
        <div className="room-leave-menu classroom-leave-menu" ref={menuRef}>
          <button
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="room-leave-trigger"
            disabled={leaving}
            onClick={() => setMenuOpen((open) => !open)}
            type="button"
          >
            Leave
          </button>
          {menuOpen && (
            <div className="room-leave-dropdown" role="menu">
              <button onClick={() => void leave()} role="menuitem" type="button">Leave session</button>
              {isHostClassRole && (
                <button
                  className="room-end-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmEnding(true);
                  }}
                  role="menuitem"
                  type="button"
                >
                  End session for all
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <div className={`classroom-workspace layout-${layout}${isHostClassRole ? " has-layout-controls" : ""}`}>
        <main className="classroom-board">
          <div className="whiteboard-placeholder">Whiteboard coming next</div>
          {error && !confirmEnding && <p className="classroom-error" role="alert">{error}</p>}
          {isHostClassRole && waitingError && (
            <p className="classroom-waiting-error" role="alert">{waitingError}</p>
          )}
          {isHostClassRole && currentGuest && (
            <div className="classroom-admit-bar">
              <span className="classroom-request-avatar">{getInitials(currentGuest.displayName || "Guest")}</span>
              <strong>{currentGuest.displayName || "A guest"} wants to join as a guest</strong>
              {visibleWaitingGuests.length > 1 && (
                <span className="classroom-more-waiting">+{visibleWaitingGuests.length - 1} more waiting</span>
              )}
              <button
                className="classroom-admit-button"
                disabled={busyGuestId === currentGuest.id}
                onClick={() => void respondToGuest(currentGuest, "admit")}
                type="button"
              >
                Admit
              </button>
              <button
                className="classroom-deny-button"
                disabled={busyGuestId === currentGuest.id}
                onClick={() => void respondToGuest(currentGuest, "deny")}
                type="button"
              >
                Deny
              </button>
              <button
                aria-label="Dismiss guest request"
                className="classroom-dismiss-request"
                onClick={() => dismissGuest(currentGuest.id)}
                type="button"
              >
                <X aria-hidden="true" size={15} />
              </button>
            </div>
          )}
        </main>

        <aside className="classroom-side-panel">
          {peopleOpen ? (
            <div className="classroom-people-panel">
              <header>
                <div>
                  <strong>People</strong>
                  <span>{visibleParticipants.length} people in class</span>
                </div>
                <button aria-label="Close people panel" onClick={() => setPeopleOpen(false)} type="button">
                  <X aria-hidden="true" size={17} />
                </button>
              </header>
              <div className="classroom-people-section">
                <span className="classroom-section-label">MAIN ROOM · {visibleParticipants.length}</span>
                {visibleParticipants.map((participant, index) => {
                  const isYou = participant.identity === localParticipant.identity;
                  const role = readParticipantRole(participant) ?? (isYou ? classRole : null);
                  const name = participant.name || participant.identity;
                  const muted = !participant.getTrackPublication(Track.Source.Microphone) ||
                    participant.getTrackPublication(Track.Source.Microphone)?.isMuted;
                  return (
                    <div className="classroom-person-row" key={participant.identity}>
                      <span className={`classroom-person-avatar avatar-color-${index % 4}`}>{getInitials(name)}</span>
                      <span className="classroom-person-copy">
                        <strong>{name}{isYou ? " (you)" : ""}</strong>
                        <span>{formatClassRole(role)}{muted ? " · Muted" : ""}</span>
                      </span>
                      {!isYou && (
                        <button aria-label={`${name} options`} className="classroom-person-menu" disabled title="Coming soon" type="button">
                          <MoreVertical aria-hidden="true" size={16} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="classroom-video-panel">
              <header className="classroom-video-heading">
                <strong>{roomName || "Main room"}</strong>
                <span>{visibleParticipants.length} people</span>
              </header>
              <div className={`classroom-video-grid ${layout === "sidebar" ? "single-column" : ""}`}>
                {visibleParticipants.map((participant, index) => {
                  const isYou = participant.identity === localParticipant.identity;
                  const role = readParticipantRole(participant) ?? (isYou ? classRole : null);
                  const name = participant.name || participant.identity;
                  const cameraTrack = cameraTracks.find((track) =>
                    track.participant.identity === participant.identity &&
                    isTrackReference(track) &&
                    Boolean(track.publication.track) &&
                    !track.publication.isMuted,
                  );
                  const screenShareTrack = screenShareTracks.find(
                    (track) => track.participant.identity === participant.identity,
                  );
                  const videoTrack = cameraTrack ?? screenShareTrack;
                  const muted = !participant.getTrackPublication(Track.Source.Microphone) ||
                    participant.getTrackPublication(Track.Source.Microphone)?.isMuted;
                  return (
                    <article
                      className={`classroom-video-tile${participant.isSpeaking ? " speaking" : ""}${layout === "floating" ? " floating-tile" : ""}`}
                      key={participant.identity}
                    >
                      {videoTrack ? (
                        <ParticipantTile
                          className="classroom-video-track"
                          disableSpeakingIndicator
                          trackRef={videoTrack}
                        />
                      ) : (
                        <span className={`classroom-tile-avatar avatar-color-${index % 4}`}>{getInitials(name)}</span>
                      )}
                      <div className="classroom-tile-footer">
                        <span>{name}{isYou ? " (you)" : ""}</span>
                        {role === "guest" && <em>Guest</em>}
                        {muted && <MicOff aria-label="Microphone muted" size={13} />}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </aside>

        {isHostClassRole && (
          <nav aria-label="Participant layout" className="classroom-layout-bar">
            <button aria-label="Grid layout" aria-pressed={layout === "grid"} className={layout === "grid" ? "selected" : ""} onClick={() => setLayout("grid")} title="Grid" type="button">
              <Grid2X2 aria-hidden="true" size={17} />
            </button>
            <button aria-label="Sidebar layout" aria-pressed={layout === "sidebar"} className={layout === "sidebar" ? "selected" : ""} onClick={() => setLayout("sidebar")} title="Sidebar" type="button">
              <PanelRight aria-hidden="true" size={17} />
            </button>
            <button aria-label="Floating layout" aria-pressed={layout === "floating"} className={layout === "floating" ? "selected" : ""} onClick={() => setLayout("floating")} title="Floating" type="button">
              <PictureInPicture2 aria-hidden="true" size={17} />
            </button>
          </nav>
        )}

        <nav aria-label="Classroom tools" className="classroom-action-bar">
          <button aria-label="Settings" disabled title="Coming soon" type="button"><Settings aria-hidden="true" size={17} /></button>
          <button
            aria-label={isScreenShareEnabled ? "Stop sharing screen" : "Share screen"}
            className={isScreenShareEnabled ? "selected" : ""}
            disabled={!canPublish || screenSharePending}
            onClick={() => void toggleScreenShare()}
            title={
              !canPublish
                ? "Observers cannot share"
                : screenSharePending
                  ? "Waiting for screen selection"
                  : isScreenShareEnabled
                    ? "Stop sharing screen"
                    : "Share screen"
            }
            type="button"
          >
            <MonitorUp aria-hidden="true" size={17} />
          </button>
          <button aria-label={isMicrophoneEnabled ? "Mute microphone" : "Turn microphone on"} className={isMicrophoneEnabled ? "" : "control-off"} disabled={!canPublish} onClick={() => void toggleMicrophone()} title={canPublish ? (isMicrophoneEnabled ? "Mute microphone" : "Turn microphone on") : "Observers cannot publish"} type="button">
            {isMicrophoneEnabled ? <Mic aria-hidden="true" size={17} /> : <MicOff aria-hidden="true" size={17} />}
          </button>
          <button aria-label={isCameraEnabled ? "Turn camera off" : "Turn camera on"} className={isCameraEnabled ? "" : "control-off"} disabled={!canPublish} onClick={() => void toggleCamera()} title={canPublish ? (isCameraEnabled ? "Turn camera off" : "Turn camera on") : "Observers cannot publish"} type="button">
            {isCameraEnabled ? <Video aria-hidden="true" size={17} /> : <CameraOff aria-hidden="true" size={17} />}
          </button>
          <button aria-label="Raise hand" disabled title="Coming soon" type="button"><Hand aria-hidden="true" size={17} /></button>
          <button aria-label="Reactions" disabled title="Coming soon" type="button"><Smile aria-hidden="true" size={17} /></button>
          <button aria-label={peopleOpen ? "Close people panel" : "Open people panel"} className={peopleOpen ? "selected" : ""} onClick={() => setPeopleOpen((open) => !open)} title="People" type="button">
            <UsersRound aria-hidden="true" size={17} />
          </button>
          <button aria-label="Chat" disabled title="Coming soon" type="button"><MessageCircle aria-hidden="true" size={17} /></button>
        </nav>
      </div>

      {confirmEnding && (
        <div className="dialog-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !leaving) setConfirmEnding(false);
        }}>
          <section aria-labelledby="end-session-title" aria-modal="true" className="space-dialog" role="dialog">
            <span className="eyebrow destructive-eyebrow">END SESSION</span>
            <h2 id="end-session-title">End the class for everyone?</h2>
            <p className="delete-confirmation">Everyone leaves now and recording stops. Boards are saved.</p>
            {error && <p className="dialog-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <button className="secondary-button" disabled={leaving} onClick={() => setConfirmEnding(false)} type="button">Cancel</button>
              <button className="destructive-button" disabled={leaving} onClick={() => void endForEveryone()} type="button">
                {leaving ? "Ending..." : "End for all"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

type JoinStep = "checking" | "signed-in" | "guest" | "waiting" | "denied" | "invalid" | "error";

function getJoinPath(state: unknown): string | null {
  if (
    typeof state === "object" &&
    state !== null &&
    "joinPath" in state &&
    typeof state.joinPath === "string" &&
    state.joinPath.startsWith("/join?")
  ) {
    return state.joinPath;
  }
  return null;
}

function joinFailureMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError && cause.status === 429) {
    return "Too many join requests. Please wait a minute and try again.";
  }
  return fallback;
}

function JoinPage() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const query = new URLSearchParams(location.search);
  const token = query.get("token");
  const joinPath = `${location.pathname}${location.search}`;
  const observer = query.get("observer") === "1";
  const [step, setStep] = useState<JoinStep>("checking");
  const [spaceName, setSpaceName] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [signedInName, setSignedInName] = useState("");

  useEffect(() => {
    let active = true;
    setStep("checking");
    setError("");
    setSessionId(null);

    async function initialize() {
      if (!token) {
        setStep("invalid");
        return;
      }

      let resolvedSpace: { id: string; name: string };
      try {
        const result = await resolveInvite(token);
        resolvedSpace = result.space;
        if (active) setSpaceName(resolvedSpace.name);
      } catch {
        if (active) setStep("invalid");
        return;
      }
      if (!active) return;

      if (observer) {
        try {
          const result = await joinSpace(token);
          if (!active) return;
          setSessionId(result.session.id);
          if (result.participant.status === "admitted") {
            navigate("/lobby", { state: { spaceName: resolvedSpace.name, fromJoin: true, joinPath } });
          } else {
            setStep(result.participant.status);
          }
        } catch (cause) {
          if (active) {
            setError(joinFailureMessage(cause, "We couldn’t join as an observer. Check your connection and try again."));
            setStep("error");
          }
        }
        return;
      }

      let currentUser: User | null;
      try {
        const result = await getCurrentUser();
        currentUser = result.user;
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) {
          currentUser = null;
        } else {
          if (active) {
            setError("We couldn’t check your sign-in. Check your connection and try again.");
            setStep("error");
          }
          return;
        }
      }
      if (!active) return;

      setSignedInName(currentUser?.name ?? "");
      try {
        const existing = await getJoinStatus();
        if (!active) return;
        if (existing.spaceId === resolvedSpace.id && existing.status === "waiting") {
          setSessionId(existing.sessionId);
          setStep("waiting");
          return;
        }
        if (existing.spaceId === resolvedSpace.id && existing.status === "denied") {
          setSessionId(existing.sessionId);
          setStep("denied");
          return;
        }
      } catch (cause) {
        if (!(cause instanceof ApiError && [401, 404].includes(cause.status))) {
          if (active) {
            setError("We couldn’t check your class status. Check your connection and try again.");
            setStep("error");
          }
          return;
        }
      }
      if (active) setStep(currentUser ? "signed-in" : "guest");
    }

    void initialize();
    return () => {
      active = false;
    };
  }, [attempt, joinPath, location.search, navigate, observer, token]);

  useEffect(() => {
    if (step !== "waiting" || !sessionId) return;
    let active = true;
    const timer = window.setInterval(() => {
      getJoinStatus()
        .then((result) => {
          if (!active) return;
          setSessionId(result.sessionId);
          if (result.status === "admitted") {
            navigate("/lobby", { state: { spaceName, fromJoin: true, joinPath } });
          } else if (result.status === "denied") {
            setStep("denied");
          }
        })
        .catch(() => {
          if (active) {
            setError("We couldn’t check your place in the class. Check your connection and try again.");
            setStep("error");
          }
        });
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [joinPath, navigate, sessionId, spaceName, step]);

  async function submitJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await joinSpace(token, name.trim());
      setSessionId(result.session.id);
      if (result.participant.status === "admitted") {
        navigate("/lobby", { state: { spaceName, fromJoin: true, joinPath } });
      } else {
        setStep(result.participant.status);
      }
    } catch (cause) {
      setError(joinFailureMessage(cause, "We couldn’t join this class. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  async function continueAsUser() {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      const result = await joinSpace(token);
      setSessionId(result.session.id);
      if (result.participant.status === "admitted") {
        navigate("/lobby", { state: { spaceName, fromJoin: true, joinPath } });
      } else {
        setStep(result.participant.status);
      }
    } catch (cause) {
      setError(joinFailureMessage(cause, "We couldn’t join this class. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  async function chooseDifferentPerson() {
    setBusy(true);
    setError("");
    try {
      await logout();
      setName("");
      setStep("guest");
    } catch {
      setError("We couldn’t sign you out. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function leaveWaitingRoom() {
    if (!sessionId) return;
    setBusy(true);
    setError("");
    try {
      await leaveSession(sessionId);
      navigate("/left", { replace: true, state: { joinPath } });
    } catch {
      setError("We couldn’t leave the class. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (step === "checking") {
    return (
      <JoinPageFrame>
        <p className="join-loading">Checking your invite...</p>
      </JoinPageFrame>
    );
  }

  if (step === "invalid") {
    return (
      <JoinPageFrame>
        <div className="join-icon"><Video aria-hidden="true" size={25} /></div>
        <h1>Invalid or expired link</h1>
      </JoinPageFrame>
    );
  }

  if (step === "error") {
    return (
      <JoinPageFrame>
        <div className="join-icon"><Video aria-hidden="true" size={25} /></div>
        <h1>We couldn’t continue</h1>
        <p className="join-error" role="alert">{error}</p>
        <button className="primary-button join-primary" onClick={() => setAttempt((value) => value + 1)} type="button">
          Try again
        </button>
      </JoinPageFrame>
    );
  }

  if (step === "waiting") {
    return (
      <JoinPageFrame>
        <div className="join-icon"><UsersRound aria-hidden="true" size={25} /></div>
        <span className="eyebrow">ALMOST THERE</span>
        <h1>Waiting to be let in</h1>
        <p className="join-space-name">{spaceName}</p>
        <p className="waiting-copy">The tutor will let you in shortly. Keep this page open, we’ll bring you in automatically.</p>
        <div aria-label="Waiting" className="waiting-dots"><i /><i /><i /></div>
        <p className="waiting-tip">Your camera and microphone stay off until you’re in.</p>
        {error && <p className="join-error" role="alert">{error}</p>}
        <button className="secondary-button join-secondary" disabled={busy} onClick={() => void leaveWaitingRoom()} type="button">
          {busy ? "Leaving..." : "Leave"}
        </button>
      </JoinPageFrame>
    );
  }

  if (step === "denied") {
    return (
      <JoinPageFrame>
        <div className="join-icon"><UsersRound aria-hidden="true" size={25} /></div>
        <h1>The tutor couldn’t let you in this time</h1>
        <button className="join-back-link" onClick={() => navigate(-1)} type="button">
          <span aria-hidden="true">‹</span> Back
        </button>
      </JoinPageFrame>
    );
  }

  if (step === "signed-in") {
    return (
      <JoinPageFrame>
        <div className="join-icon"><Video aria-hidden="true" size={25} /></div>
        <span className="eyebrow">READY TO JOIN</span>
        <h1>You’re joining as<br />{signedInName || user?.name || "you"}</h1>
        <p className="join-space-name">{spaceName}</p>
        {error && <p className="join-error" role="alert">{error}</p>}
        <button className="primary-button join-primary" disabled={busy} onClick={() => void continueAsUser()} type="button">
          {busy ? "Joining..." : <>Continue <ChevronRight aria-hidden="true" size={18} /></>}
        </button>
        <button className="join-text-button" disabled={busy} onClick={() => void chooseDifferentPerson()} type="button">
          That’s not me
        </button>
        <p className="join-hint">Your camera and microphone are checked on the next screen.</p>
      </JoinPageFrame>
    );
  }

  return (
    <JoinPageFrame>
      <button className="join-back-link" onClick={() => navigate(-1)} type="button">
        <span aria-hidden="true">‹</span> Back
      </button>
      <div className="join-icon"><UsersRound aria-hidden="true" size={25} /></div>
      <h1>Join Space as Guest</h1>
      <form className="guest-join-form" onSubmit={submitJoin}>
        <div className="guest-label-row">
          <label htmlFor="guest-name">Your Name</label>
          <span>Required</span>
        </div>
        <input
          autoComplete="name"
          autoFocus
          id="guest-name"
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          placeholder="Enter your name"
          required
          value={name}
        />
        {error && <p className="join-error" role="alert">{error}</p>}
        <button className="primary-button join-primary" disabled={busy || !name.trim()} type="submit">
          {busy ? "Joining..." : <>Join as Guest <ChevronRight aria-hidden="true" size={18} /></>}
        </button>
        <Link
          className="secondary-button join-secondary"
          to="/sign-in"
          state={{
            from: { pathname: location.pathname, search: location.search },
            fromJoin: true,
          }}
        >
          Join with Email
        </Link>
      </form>
      <p className="join-hint guest-hint"><Wifi aria-hidden="true" size={14} /> Optimised for low-bandwidth connections</p>
    </JoinPageFrame>
  );
}

function JoinPageFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <main className={`join-page${className ? ` ${className}` : ""}`}>
      <header className="signin-brand"><Logo /></header>
      <section className="join-card">{children}</section>
      <p className="low-data-note"><Wifi aria-hidden="true" size={15} /> Optimised for low-bandwidth connections</p>
    </main>
  );
}

type LobbyDeviceState = "checking" | "ready" | "off" | "denied" | "missing";

function isPermissionFailure(cause: unknown): boolean {
  return cause instanceof DOMException &&
    (cause.name === "NotAllowedError" || cause.name === "PermissionDeniedError" || cause.name === "SecurityError");
}

function LobbyPage() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const previewRef = useRef<HTMLVideoElement>(null);
  const [checking, setChecking] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
  const [cameraDeviceId, setCameraDeviceId] = useState("");
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState("");
  const [speakerDeviceId, setSpeakerDeviceId] = useState("");
  const [cameraState, setCameraState] = useState<LobbyDeviceState>("checking");
  const [microphoneState, setMicrophoneState] = useState<LobbyDeviceState>("checking");
  const [cameraPermissionDenied, setCameraPermissionDenied] = useState(false);
  const [microphonePermissionDenied, setMicrophonePermissionDenied] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [permissionAttempt, setPermissionAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [speakerTestRunning, setSpeakerTestRunning] = useState(false);
  const pageState: unknown = location.state;
  const fromJoin =
    typeof pageState === "object" &&
    pageState !== null &&
    "fromJoin" in pageState &&
    pageState.fromJoin === true;
  const spaceName =
    typeof pageState === "object" &&
    pageState !== null &&
    "spaceName" in pageState &&
    typeof pageState.spaceName === "string"
      ? pageState.spaceName
      : "";
  const joinPath = getJoinPath(pageState);

  useEffect(() => {
    let active = true;
    function returnToJoin() {
      if (fromJoin) {
        navigate(-1);
      } else {
        navigate("/join", { replace: true });
      }
    }
    getJoinStatus()
      .then((result) => {
        if (!active) return;
        if (result.status !== "admitted") {
          returnToJoin();
          return;
        }
        setChecking(false);
      })
      .catch(() => {
        if (active) returnToJoin();
      });
    return () => {
      active = false;
    };
  }, [fromJoin, navigate]);

  useEffect(() => {
    if (checking) return;
    let active = true;
    let cameraStream: MediaStream | null = null;
    let cameraTrack: MediaStreamTrack | null = null;
    let cameraTrackEndedHandler: (() => void) | null = null;
    let microphoneStream: MediaStream | null = null;

    async function initializeDevices() {
      setCameraState(cameraEnabled ? "checking" : "off");
      setMicrophoneState(microphoneEnabled ? "checking" : "off");
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraState("missing");
        setMicrophoneState("missing");
        setCameraEnabled(false);
        setMicrophoneEnabled(false);
        return;
      }
      const tasks: Promise<void>[] = [];

      if (cameraEnabled) {
        tasks.push(
          navigator.mediaDevices.getUserMedia({
            audio: false,
            video: cameraDeviceId ? { deviceId: { exact: cameraDeviceId } } : true,
          }).then((stream) => {
            if (!active) {
              stream.getTracks().forEach((track) => track.stop());
              return;
            }
            const videoTrack = stream.getVideoTracks().find((track) => track.readyState === "live");
            if (!videoTrack) {
              stream.getTracks().forEach((track) => track.stop());
              setCameraState("missing");
              setCameraEnabled(false);
              return;
            }
            const videoElement = previewRef.current;
            if (!videoElement) {
              stream.getTracks().forEach((track) => track.stop());
              setCameraState("missing");
              setCameraEnabled(false);
              return;
            }
            cameraStream = stream;
            cameraTrack = videoTrack;
            cameraTrackEndedHandler = () => {
              if (!active) return;
              setCameraState("missing");
              setCameraEnabled(false);
            };
            videoTrack.addEventListener("ended", cameraTrackEndedHandler);
            videoElement.srcObject = stream;
            void videoElement.play().catch(() => undefined);
            setCameraState("ready");
            setCameraPermissionDenied(false);
          }).catch((cause: unknown) => {
            if (!active) return;
            const denied = isPermissionFailure(cause);
            setCameraState(denied ? "denied" : "missing");
            setCameraPermissionDenied(denied);
          }),
        );
      } else if (previewRef.current) {
        previewRef.current.srcObject = null;
      }

      if (microphoneEnabled) {
        tasks.push(
          navigator.mediaDevices.getUserMedia({
            audio: microphoneDeviceId ? { deviceId: { exact: microphoneDeviceId } } : true,
            video: false,
          }).then((stream) => {
            if (!active) {
              stream.getTracks().forEach((track) => track.stop());
              return;
            }
            microphoneStream = stream;
            setMicrophoneState("ready");
            setMicrophonePermissionDenied(false);
          }).catch((cause: unknown) => {
            if (!active) return;
            const denied = isPermissionFailure(cause);
            setMicrophoneState(denied ? "denied" : "missing");
            setMicrophonePermissionDenied(denied);
          }),
        );
      }

      await Promise.all(tasks);
      if (!active) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!active) return;
        setCameras(devices.filter((device) => device.kind === "videoinput"));
        setMicrophones(devices.filter((device) => device.kind === "audioinput"));
        setSpeakers(devices.filter((device) => device.kind === "audiooutput"));
      } catch {
        if (active) {
          setCameras([]);
          setMicrophones([]);
          setSpeakers([]);
        }
      }
    }

    void initializeDevices();
    return () => {
      active = false;
      if (cameraTrack && cameraTrackEndedHandler) {
        cameraTrack.removeEventListener("ended", cameraTrackEndedHandler);
      }
      cameraStream?.getTracks().forEach((track) => track.stop());
      microphoneStream?.getTracks().forEach((track) => track.stop());
      if (previewRef.current?.srcObject === cameraStream) {
        previewRef.current.srcObject = null;
      }
    };
  }, [
    cameraDeviceId,
    cameraEnabled,
    checking,
    microphoneDeviceId,
    microphoneEnabled,
    permissionAttempt,
  ]);

  async function testSpeakers() {
    setSpeakerTestRunning(true);
    try {
      const audioContext = new AudioContext();
      const selectableContext = audioContext as AudioContext & {
        setSinkId?: (deviceId: string) => Promise<void>;
      };
      if (speakerDeviceId && selectableContext.setSinkId) {
        await selectableContext.setSinkId(speakerDeviceId);
      }
      await audioContext.resume();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = 660;
      gain.gain.value = 0.08;
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.onended = () => {
        void audioContext.close();
        setSpeakerTestRunning(false);
      };
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.35);
    } catch {
      setSpeakerTestRunning(false);
      setError("Speaker testing isn’t available in this browser.");
    }
  }

  async function logOut() {
    setBusy(true);
    setError("");
    try {
      await logout();
      navigate("/sign-in", { replace: true });
    } catch {
      setError("We couldn’t log you out. Please try again.");
      setBusy(false);
    }
  }

  function joinClass() {
    roomMediaPreferences = {
      cameraEnabled: cameraEnabled && cameraState === "ready",
      microphoneEnabled: microphoneEnabled && microphoneState === "ready",
      cameraDeviceId,
      microphoneDeviceId,
      speakerDeviceId,
    };
    navigate("/room-test", { state: { joinPath } });
  }

  const permissionNeeded =
    cameraState === "checking" ||
    microphoneState === "checking" ||
    cameraPermissionDenied ||
    microphonePermissionDenied;
  const mediaChecking = cameraState === "checking" || microphoneState === "checking";

  if (checking) {
    return (
      <JoinPageFrame>
        <p className="join-loading">Checking your place in the class...</p>
      </JoinPageFrame>
    );
  }

  return (
    <main className="lobby-page">
      <header className="lobby-header">
        <Logo />
        <button className="lobby-back" onClick={() => navigate(-1)} type="button">
          <ChevronRight aria-hidden="true" size={16} /> Back
        </button>
      </header>
      <div className="lobby-layout">
        <section className="lobby-preview-column">
          <div className={`lobby-preview${cameraState !== "ready" ? " camera-unavailable" : ""}`}>
            <video autoPlay muted playsInline ref={previewRef} />
            {cameraState !== "ready" && (
              <div className="lobby-avatar" aria-label="Camera preview unavailable">
                <span />
                <i />
              </div>
            )}
            <strong>{user?.name || "Guest"}</strong>
            <span className="lobby-network"><Wifi aria-hidden="true" size={14} /> Ready to connect</span>
          </div>
          <div className="lobby-toggle-row">
            <button
              aria-checked={microphoneEnabled && microphoneState === "ready"}
              className="lobby-toggle"
              role="switch"
              onClick={() => {
                if (microphoneState === "ready") {
                  setMicrophoneEnabled((enabled) => !enabled);
                } else {
                  setMicrophoneEnabled(true);
                  setMicrophoneState("checking");
                  setPermissionAttempt((attempt) => attempt + 1);
                }
              }}
              type="button"
            >
              {microphoneEnabled && microphoneState === "ready" ? <Mic size={17} /> : <MicOff size={17} />}
              Microphone {microphoneEnabled && microphoneState === "ready" ? "on" : "off"}
            </button>
            <button
              aria-checked={cameraEnabled && cameraState === "ready"}
              className="lobby-toggle"
              role="switch"
              onClick={() => {
                if (cameraState === "ready") {
                  setCameraEnabled((enabled) => !enabled);
                } else {
                  setCameraEnabled(true);
                  setCameraState("checking");
                  setPermissionAttempt((attempt) => attempt + 1);
                }
              }}
              type="button"
            >
              {cameraEnabled && cameraState === "ready" ? <Camera size={17} /> : <CameraOff size={17} />}
              Camera {cameraEnabled && cameraState === "ready" ? "on" : "off"}
            </button>
          </div>
          {(cameraState === "missing" || microphoneState === "missing" ||
            cameraPermissionDenied || microphonePermissionDenied) && (
            <p className="lobby-friendly-message">
              You can still join without a camera or microphone.
            </p>
          )}
        </section>

        <section className="lobby-settings">
          <span className="lobby-open-label"><i /> Class is open</span>
          <h1>Ready to join?</h1>
          {spaceName && <p className="lobby-space-name">{spaceName}</p>}

          <details className="lobby-devices" open>
            <summary><span>Devices</span><ChevronDown aria-hidden="true" size={16} /></summary>
            <label>
              <Mic aria-hidden="true" size={17} />
              <span>Microphone</span>
              <select
                aria-label="Choose microphone"
                onChange={(event) => {
                  setMicrophoneState("checking");
                  setMicrophoneDeviceId(event.target.value);
                }}
                value={microphoneDeviceId}
              >
                <option value="">Default microphone</option>
                {microphones.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <Camera aria-hidden="true" size={17} />
              <span>Camera</span>
              <select
                aria-label="Choose camera"
                onChange={(event) => {
                  setCameraState("checking");
                  setCameraDeviceId(event.target.value);
                }}
                value={cameraDeviceId}
              >
                <option value="">Default camera</option>
                {cameras.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <Volume2 aria-hidden="true" size={17} />
              <span>Speaker</span>
              <select aria-label="Choose speaker" onChange={(event) => setSpeakerDeviceId(event.target.value)} value={speakerDeviceId}>
                <option value="">Default speaker</option>
                {speakers.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label || `Speaker ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          </details>

          <div className="lobby-actions">
            <button className="lobby-link-button" disabled={speakerTestRunning} onClick={() => void testSpeakers()} type="button">
              {speakerTestRunning ? "Playing sound..." : "Test speakers"}
            </button>
            {permissionNeeded && (
              <button
                className="lobby-link-button"
                onClick={() => {
                  setCameraEnabled(true);
                  setMicrophoneEnabled(true);
                  setPermissionAttempt((attempt) => attempt + 1);
                }}
                type="button"
              >
                Request microphone and camera permission
              </button>
            )}
          </div>
          {error && <p className="join-error" role="alert">{error}</p>}
          <button className="primary-button lobby-join-button" disabled={busy || mediaChecking} onClick={joinClass} type="button">
            <Video aria-hidden="true" size={17} /> Join class
          </button>
          {user && (
            <p className="lobby-account">
              Logged in as {user.name} ·{" "}
              <button disabled={busy} onClick={() => void logOut()} type="button">
                <LogOut aria-hidden="true" size={13} /> Log out
              </button>
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

function EndedPage() {
  const location = useLocation();
  return <ClassExitPage title="Class ended" joinPath={getJoinPath(location.state)} />;
}

function LeftPage() {
  const location = useLocation();
  return <ClassExitPage title="You left the class" joinPath={getJoinPath(location.state)} />;
}

function ClassExitPage({
  title,
  joinPath,
}: {
  title: "Class ended" | "You left the class";
  joinPath: string | null;
}) {
  const { user, status } = useAuth();
  if (status === "loading") {
    return <JoinPageFrame><p className="join-loading">Checking your sign-in...</p></JoinPageFrame>;
  }

  return (
    <JoinPageFrame className="class-exit-page">
      <h1>{title}</h1>
      <p className="exit-card-copy">Boards and chat are saved in this space.</p>
      {user && <Link className="primary-button join-primary" to="/spaces">Back to Spaces</Link>}
      {joinPath && <Link className="class-ended-rejoin" to={joinPath}>Rejoin class</Link>}
    </JoinPageFrame>
  );
}

function AuthLoading() {
  const { status, retry } = useAuth();
  if (status === "loading") {
    return <main className="loading-screen">Checking your sign-in...</main>;
  }
  if (status === "error") {
    return (
      <main className="loading-screen auth-error">
        <p>We couldn&apos;t connect to your account. Check your connection and try again.</p>
        <button className="primary-button" onClick={retry} type="button">Try again</button>
      </main>
    );
  }
  return null;
}

export function App() {
  const { status } = useAuth();
  const location = useLocation();
  const publicFlowPaths = ["/join", "/room-test", "/lobby", "/left", "/ended"];
  if (status !== "ready" && !publicFlowPaths.includes(location.pathname)) {
    return <AuthLoading />;
  }

  return (
    <Routes>
      <Route path="/sign-in" element={<SignInPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/join" element={<JoinPage />} />
      <Route path="/room-test" element={<RoomTestPage />} />
      <Route path="/lobby" element={<LobbyPage />} />
      <Route path="/left" element={<LeftPage />} />
      <Route path="/ended" element={<EndedPage />} />
      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route path="/spaces" element={<SpacesPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/library" element={<ComingSoonPage title="Library" />} />
        <Route path="/settings" element={<ComingSoonPage title="Settings" />} />
      </Route>
      <Route path="*" element={<Navigate to="/spaces" replace />} />
    </Routes>
  );
}
