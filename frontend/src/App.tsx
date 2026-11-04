import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import {
  Eye,
  EyeOff,
  Grid2X2,
  List,
  MoreVertical,
  Plus,
  Search,
  ChevronRight,
  UsersRound,
  Video,
  X,
  Wifi,
} from "lucide-react";
import { ConnectionState, Track, VideoPresets, type RoomOptions } from "livekit-client";
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
} from "./api/client";
import { useAuth } from "./auth/AuthProvider";

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

const roomTestOptions: RoomOptions = {
  adaptiveStream: true,
  dynacast: true,
  publishDefaults: { simulcast: true },
  videoCaptureDefaults: { resolution: VideoPresets.h144 },
};

function RoomTestPage() {
  const [credentials, setCredentials] = useState<{
    token: string;
    url: string;
    sessionId: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [roomError, setRoomError] = useState("");
  const [left, setLeft] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setRoomError("");
    setLeft(false);
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

  if (left || !credentials) {
    return <main className="room-test-page">You left the class.</main>;
  }

  return (
    <main className="room-test-page">
      <LiveKitRoom
        audio
        onError={() => setRoomError("We couldn’t connect to the class. Check your connection and try again.")}
        options={roomTestOptions}
        serverUrl={credentials.url}
        token={credentials.token}
        video
      >
        <RoomAudioRenderer />
        <RoomTestControls
          error={roomError}
          onError={setRoomError}
          onLeft={() => {
            setCredentials(null);
            setLeft(true);
          }}
          sessionId={credentials.sessionId}
        />
      </LiveKitRoom>
    </main>
  );
}

function RoomTestControls({
  sessionId,
  onLeft,
  onError,
  error,
}: {
  sessionId: string;
  onLeft: () => void;
  onError: (message: string) => void;
  error: string;
}) {
  const connectionState = useConnectionState();
  const tracks = useTracks([Track.Source.Camera], { onlySubscribed: false });
  const { isCameraEnabled, isMicrophoneEnabled, localParticipant } = useLocalParticipant();
  const room = useRoomContext();
  const [leaving, setLeaving] = useState(false);

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
        resolution: VideoPresets.h144,
      });
    } catch {
      onError("We couldn’t change your camera setting.");
    }
  }

  async function leave() {
    setLeaving(true);
    try {
      await room.disconnect();
      await leaveSession(sessionId);
      onLeft();
    } catch {
      onError("You disconnected from video, but couldn’t update your class status. Try Leave again.");
      setLeaving(false);
    }
  }

  return (
    <section className="room-test-content">
      <p>Connection state: {stateLabel}</p>
      {error && <p role="alert">{error}</p>}
      <div className="room-test-tiles">
        {tracks.map((track) => (
          <div className="room-test-tile" key={`${track.participant.identity}-${track.source}`}>
            <ParticipantTile trackRef={track} />
            <span>{track.participant.name || track.participant.identity}</span>
          </div>
        ))}
      </div>
      <div className="room-test-controls">
        <button onClick={() => void toggleMicrophone()} type="button">
          {isMicrophoneEnabled ? "Mute microphone" : "Turn microphone on"}
        </button>
        <button onClick={() => void toggleCamera()} type="button">
          {isCameraEnabled ? "Turn camera off" : "Turn camera on"}
        </button>
        <button disabled={leaving} onClick={() => void leave()} type="button">
          {leaving ? "Leaving..." : "Leave"}
        </button>
      </div>
    </section>
  );
}

type JoinStep = "checking" | "signed-in" | "guest" | "waiting" | "denied" | "invalid" | "error";

function JoinPage() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const query = new URLSearchParams(location.search);
  const token = query.get("token");
  const observer = query.get("observer") === "1";
  const [step, setStep] = useState<JoinStep>("checking");
  const [spaceName, setSpaceName] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
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
            navigate("/lobby", { replace: true });
          } else {
            setStep(result.participant.status);
          }
        } catch {
          if (active) {
            setError("We couldn’t join as an observer. Check your connection and try again.");
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

      setSignedIn(Boolean(currentUser));
      setSignedInName(currentUser?.name ?? "");
      try {
        const existing = await getJoinStatus();
        if (!active) return;
        if (existing.status === "waiting" && existing.spaceId === resolvedSpace.id) {
          setSessionId(existing.sessionId);
          setStep("waiting");
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
  }, [attempt, location.search, navigate, observer, token]);

  useEffect(() => {
    if (step !== "waiting" || !sessionId) return;
    let active = true;
    const timer = window.setInterval(() => {
      getJoinStatus()
        .then((result) => {
          if (!active) return;
          setSessionId(result.sessionId);
          if (result.status === "admitted") {
            navigate("/lobby", { replace: true });
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
  }, [navigate, sessionId, step]);

  async function submitJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await joinSpace(token, name.trim());
      setSessionId(result.session.id);
      if (result.participant.status === "admitted") {
        navigate("/lobby", { replace: true });
      } else {
        setStep(result.participant.status);
      }
    } catch {
      setError("We couldn’t join this class. Check your connection and try again.");
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
        navigate("/lobby", { replace: true });
      } else {
        setStep(result.participant.status);
      }
    } catch {
      setError("We couldn’t join this class. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function chooseDifferentPerson() {
    setBusy(true);
    setError("");
    try {
      await logout();
      setSignedIn(false);
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
      setSessionId(null);
      setStep(signedIn ? "signed-in" : "guest");
      setName("");
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
        <h1>Waiting for the tutor to let you in</h1>
        <p className="join-space-name">{spaceName}</p>
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
        <h1>The tutor didn’t let you in</h1>
        <p className="join-space-name">{spaceName}</p>
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

function JoinPageFrame({ children }: { children: ReactNode }) {
  return (
    <main className="join-page">
      <header className="signin-brand"><Logo /></header>
      <section className="join-card">{children}</section>
      <p className="low-data-note"><Wifi aria-hidden="true" size={15} /> Optimised for low-bandwidth connections</p>
    </main>
  );
}

function LobbyPlaceholder() {
  return (
    <JoinPageFrame>
      <div className="join-icon"><Video aria-hidden="true" size={25} /></div>
      <h1>Camera and microphone check coming next</h1>
    </JoinPageFrame>
  );
}

function EndedPage() {
  const { user } = useAuth();
  return (
    <JoinPageFrame>
      <div className="join-icon"><Video aria-hidden="true" size={25} /></div>
      <h1>This class has ended</h1>
      {user && <Link className="primary-button join-primary" to="/spaces">Back to Spaces</Link>}
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
  const publicFlowPaths = ["/join", "/room-test", "/lobby", "/ended"];
  if (status !== "ready" && !publicFlowPaths.includes(location.pathname)) {
    return <AuthLoading />;
  }

  return (
    <Routes>
      <Route path="/sign-in" element={<SignInPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/join" element={<JoinPage />} />
      <Route path="/room-test" element={<RoomTestPage />} />
      <Route path="/lobby" element={<LobbyPlaceholder />} />
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
