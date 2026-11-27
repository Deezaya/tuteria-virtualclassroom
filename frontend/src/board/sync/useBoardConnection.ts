import { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { getBoardToken } from "../../api/client";
import type { ClassRole } from "../types";

export type BoardConnectionStatus = "Reconnecting…" | "Connected" | "Offline";

const apiUrl = import.meta.env.VITE_API_URL;
const configuredBoardSocketUrl = import.meta.env.VITE_BOARD_WS_URL;

if (!apiUrl) {
  throw new Error("VITE_API_URL must be set to the backend URL.");
}
if (!configuredBoardSocketUrl) {
  throw new Error("VITE_BOARD_WS_URL must be set to the board WebSocket URL.");
}

const boardSocketUrl = new URL(configuredBoardSocketUrl, apiUrl);
if (boardSocketUrl.protocol === "https:") boardSocketUrl.protocol = "wss:";
if (boardSocketUrl.protocol === "http:") boardSocketUrl.protocol = "ws:";
boardSocketUrl.pathname = "/board";
boardSocketUrl.search = "";
boardSocketUrl.hash = "";
const boardWsUrl = boardSocketUrl.toString();

/**
 * Connects a drawing engine to the board document. The hook owns the Yjs
 * document and the Hocuspocus provider; the engine supplies a binding that
 * is told when to attach, refresh and let go.
 */
export type BoardBinding = {
  /** Called with the new document, before the provider is created. */
  attach(doc: Y.Doc, session: BoardSession): void;
  /** Called on every awareness change. */
  onAwarenessChange(): void;
  /** Called once the provider is created, and again each time it syncs. */
  onSync(): void;
  /** Called first when disconnecting, while the document is still alive. */
  detach(): void;
  /** Called last when disconnecting, after the provider and document are destroyed. */
  release(): void;
};

export type BoardSession = {
  documentName: string;
  participantId: string;
};

export type BoardBindingContext = {
  getProvider(): HocuspocusProvider | null;
};

type BoardConnectionOptions = {
  classRole: ClassRole;
  displayName: string;
  roomId: string | null;
  sessionId: string;
  spyMode: boolean;
  /** Which document of the board: the main one (default) or its locked layer. */
  layer?: "main" | "locked";
  /** Whether to announce this person in awareness (default true). */
  presence?: boolean;
};

export function useBoardConnection(
  {
    classRole,
    displayName,
    roomId,
    sessionId,
    spyMode,
    layer = "main",
    presence = true,
  }: BoardConnectionOptions,
  createBinding: (context: BoardBindingContext) => BoardBinding,
) {
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [connection, setConnection] = useState<BoardConnectionStatus>("Reconnecting…");
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const docRef = useRef<Y.Doc | null>(null);
  const createBindingRef = useRef(createBinding);
  createBindingRef.current = createBinding;

  useEffect(() => {
    let active = true;
    let doc: Y.Doc | null = null;
    let provider: HocuspocusProvider | null = null;
    let onAwarenessChange: (() => void) | null = null;
    let onPageHide: (() => void) | null = null;
    let disposed = false;

    setLoading(true);
    setError(false);
    setConnection("Reconnecting…");

    const binding = createBindingRef.current({ getProvider: () => provider });

    function dispose() {
      if (disposed) return;
      disposed = true;
      binding.detach();
      if (provider && onAwarenessChange) {
        provider.off("awarenessChange", onAwarenessChange);
      }
      if (onPageHide) window.removeEventListener("pagehide", onPageHide);
      provider?.configuration.websocketProvider.disconnect();
      provider?.destroy();
      doc?.destroy();
      if (providerRef.current === provider) providerRef.current = null;
      if (docRef.current === doc) docRef.current = null;
      binding.release();
    }

    async function connect() {
      try {
        const credentials = await getBoardToken(sessionId, {
          ...(roomId ? { roomId } : {}),
          ...(spyMode ? { spy: true } : {}),
          ...(layer === "locked" ? { layer } : {}),
        });
        if (!active) return;

        doc = new Y.Doc();
        docRef.current = doc;
        binding.attach(doc, {
          documentName: credentials.documentName,
          participantId: credentials.participantId,
        });

        provider = new HocuspocusProvider({
          url: boardWsUrl,
          name: credentials.documentName,
          document: doc,
          token: async () => {
            const refreshed = await getBoardToken(sessionId, {
              ...(roomId ? { roomId } : {}),
              ...(spyMode ? { spy: true } : {}),
              ...(layer === "locked" ? { layer } : {}),
            });
            if (refreshed.documentName !== credentials.documentName) {
              throw new Error("The board session changed. Rejoin the class to continue.");
            }
            return refreshed.token;
          },
        });
        providerRef.current = provider;
        if (presence && classRole !== "observer") {
          provider.awareness?.setLocalStateField("user", {
            name: displayName,
            role: classRole,
            color: { background: "#d7e8ff", stroke: "#0759c7" },
          });
        }
        onAwarenessChange = () => binding.onAwarenessChange();
        provider.on("awarenessChange", onAwarenessChange);
        provider.on("status", ({ status }: { status: string }) => {
          if (!active) return;
          setConnection(
            status === "connected"
              ? "Connected"
              : status === "disconnected"
                ? "Offline"
                : "Reconnecting…",
          );
        });
        provider.on("authenticationFailed", () => {
          if (!active) return;
          setError(true);
          setConnection("Offline");
        });
        provider.on("synced", ({ state }: { state: boolean }) => {
          if (active && state) {
            setLoading(false);
            setError(false);
            binding.onSync();
          }
        });
        onPageHide = dispose;
        window.addEventListener("pagehide", onPageHide);
        setLoading(false);
        binding.onSync();
      } catch {
        if (!active) return;
        setLoading(false);
        setError(true);
        setConnection("Offline");
      }
    }

    void connect();
    return () => {
      active = false;
      dispose();
    };
  }, [attempt, classRole, displayName, layer, presence, roomId, sessionId, spyMode]);

  return {
    connection,
    docRef,
    error,
    loading,
    providerRef,
    retry: () => setAttempt((value) => value + 1),
  };
}
