import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  CaptureUpdateAction,
  Excalidraw,
  reconcileElements,
} from "@excalidraw/excalidraw";
import type {
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { getBoardToken } from "./api/client";
import "@excalidraw/excalidraw/index.css";

type ClassRole = "admin" | "tutor" | "student" | "guest" | "observer";
type BoardConnection = "Reconnecting…" | "Connected" | "Offline";
type BoardProps = {
  canEdit: boolean;
  classRole: ClassRole;
  displayName: string;
  sessionId: string;
};
type SerializedElement = { id: string; data: string };
type PointerUpdate = {
  pointer: { x: number; y: number; tool: "pointer" | "laser" };
  button: "down" | "up";
};

const apiUrl = new URL(import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000");
const boardSocketUrl = new URL(
  import.meta.env.VITE_BOARD_WS_URL ?? "/board",
  apiUrl,
);
boardSocketUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
boardSocketUrl.host = apiUrl.host;
boardSocketUrl.pathname = "/board";
boardSocketUrl.search = "";
boardSocketUrl.hash = "";
const boardWsUrl = boardSocketUrl.toString();
const elementMapName = "elements";
const localUpdateOrigin = {};

function serializeElements(elements: readonly OrderedExcalidrawElement[]): SerializedElement[] {
  return elements.map((element) => ({ id: element.id, data: JSON.stringify(element) }));
}

function sceneSignature(elements: readonly SerializedElement[]): string {
  return elements
    .map(({ id, data }) => `${id}\u0000${data}`)
    .sort()
    .join("\u0001");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getCollaborators(doc: Y.Doc, provider: HocuspocusProvider): Map<SocketId, Collaborator> {
  const collaborators = new Map<SocketId, Collaborator>();
  const states = provider.awareness?.getStates();
  if (!states) return collaborators;

  for (const [clientId, rawState] of states) {
    if (clientId === doc.clientID || !isRecord(rawState)) continue;
    const rawUser = rawState.user;
    const rawPointer = rawState.pointer;
    if (!isRecord(rawUser) || !isRecord(rawPointer)) continue;
    if (rawUser.role === "observer") continue;

    const name = rawUser.name;
    const x = rawPointer.x;
    const y = rawPointer.y;
    const tool = rawPointer.tool;
    if (
      typeof name !== "string" ||
      typeof x !== "number" ||
      typeof y !== "number" ||
      (tool !== "pointer" && tool !== "laser")
    ) {
      continue;
    }

    const rawColor = rawUser.color;
    const color =
      isRecord(rawColor) &&
      typeof rawColor.background === "string" &&
      typeof rawColor.stroke === "string"
        ? { background: rawColor.background, stroke: rawColor.stroke }
        : { background: "#d7e8ff", stroke: "#0759c7" };

    collaborators.set(String(clientId) as SocketId, {
      username: name,
      pointer: { x, y, tool, renderCursor: true },
      color,
      isCurrentUser: false,
    });
  }

  return collaborators;
}

function readRemoteElements(elementMap: Y.Map<string>): OrderedExcalidrawElement[] {
  return Array.from(elementMap.values())
    .map((data) => JSON.parse(data) as OrderedExcalidrawElement)
    .sort((a, b) => a.index.localeCompare(b.index));
}

export default function Whiteboard({ canEdit, classRole, displayName, sessionId }: BoardProps) {
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [connection, setConnection] = useState<BoardConnection>("Reconnecting…");
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const applyRemoteSceneRef = useRef<() => void>(() => undefined);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const docRef = useRef<Y.Doc | null>(null);
  const elementMapRef = useRef<Y.Map<string> | null>(null);
  const latestLocalElementsRef = useRef<SerializedElement[] | null>(null);
  const remoteSceneSignatureRef = useRef<string | null>(null);
  const localSyncTimerRef = useRef<number | null>(null);
  const pointerTimerRef = useRef<number | null>(null);
  const latestPointerRef = useRef<PointerUpdate | null>(null);
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;

  useEffect(() => {
    let active = true;
    let doc: Y.Doc | null = null;
    let provider: HocuspocusProvider | null = null;
    let elements: Y.Map<string> | null = null;
    let onElementsChange:
      | ((event: Y.YMapEvent<string>, transaction: Y.Transaction) => void)
      | null = null;
    let onAwarenessChange: (() => void) | null = null;
    let onPageHide: (() => void) | null = null;
    let disposed = false;

    setLoading(true);
    setError(false);
    setConnection("Reconnecting…");

    function flushLocalElements() {
      const currentMap = elements;
      const pendingElements = latestLocalElementsRef.current;
      if (!currentMap || !pendingElements || !canEditRef.current) return;

      latestLocalElementsRef.current = null;
      const changed = pendingElements.filter(
        ({ id, data }) => currentMap.get(id) !== data,
      );
      if (changed.length === 0) return;

      doc?.transact(() => {
        for (const { id, data } of changed) currentMap.set(id, data);
      }, localUpdateOrigin);
    }

    function applyRemoteScene() {
      const currentApi = apiRef.current;
      if (!currentApi || !elements || !doc) return;
      const remoteElements = readRemoteElements(elements);
      const reconciledElements = reconcileElements(
        currentApi.getSceneElementsIncludingDeleted(),
        remoteElements as unknown as Parameters<typeof reconcileElements>[1],
        currentApi.getAppState(),
      );
      const serialized = serializeElements(reconciledElements);
      remoteSceneSignatureRef.current = sceneSignature(serialized);
      currentApi.updateScene({
        elements: reconciledElements,
        collaborators: provider ? getCollaborators(doc, provider) : new Map(),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }

    function updateCollaborators() {
      const currentApi = apiRef.current;
      if (!currentApi || !doc || !provider) return;
      currentApi.updateScene({
        collaborators: getCollaborators(doc, provider),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }

    applyRemoteSceneRef.current = applyRemoteScene;

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (localSyncTimerRef.current !== null) {
        window.clearTimeout(localSyncTimerRef.current);
        localSyncTimerRef.current = null;
      }
      if (pointerTimerRef.current !== null) {
        window.clearTimeout(pointerTimerRef.current);
        pointerTimerRef.current = null;
      }
      flushLocalElements();
      if (elements && onElementsChange) elements.unobserve(onElementsChange);
      if (provider && onAwarenessChange) {
        provider.off("awarenessChange", onAwarenessChange);
      }
      if (onPageHide) window.removeEventListener("pagehide", onPageHide);
      provider?.configuration.websocketProvider.disconnect();
      provider?.destroy();
      doc?.destroy();
      if (providerRef.current === provider) providerRef.current = null;
      if (docRef.current === doc) docRef.current = null;
      if (elementMapRef.current === elements) elementMapRef.current = null;
      applyRemoteSceneRef.current = () => undefined;
      apiRef.current = null;
    }

    async function connect() {
      try {
        const credentials = await getBoardToken(sessionId);
        if (!active) return;

        doc = new Y.Doc();
        elements = doc.getMap<string>(elementMapName);
        docRef.current = doc;
        elementMapRef.current = elements;
        onElementsChange = (_event, transaction) => {
          if (transaction.origin !== localUpdateOrigin) applyRemoteScene();
        };
        if (onElementsChange) elements.observe(onElementsChange);

        provider = new HocuspocusProvider({
          url: boardWsUrl,
          name: credentials.documentName,
          document: doc,
          token: async () => {
            const refreshed = await getBoardToken(sessionId);
            if (refreshed.documentName !== credentials.documentName) {
              throw new Error("The board session changed. Rejoin the class to continue.");
            }
            return refreshed.token;
          },
        });
        providerRef.current = provider;
        if (classRole !== "observer") {
          provider.awareness?.setLocalStateField("user", {
            name: displayName,
            role: classRole,
            color: { background: "#d7e8ff", stroke: "#0759c7" },
          });
        }
        onAwarenessChange = () => updateCollaborators();
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
            applyRemoteScene();
          }
        });
        onPageHide = dispose;
        window.addEventListener("pagehide", onPageHide);
        setLoading(false);
        applyRemoteScene();
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
  }, [attempt, classRole, displayName, sessionId]);

  function handleChange(elements: readonly OrderedExcalidrawElement[]) {
    if (!canEditRef.current || !elementMapRef.current) return;
    const serialized = serializeElements(
      apiRef.current?.getSceneElementsIncludingDeleted() ?? elements,
    );
    if (remoteSceneSignatureRef.current === sceneSignature(serialized)) {
      remoteSceneSignatureRef.current = null;
      return;
    }
    remoteSceneSignatureRef.current = null;
    latestLocalElementsRef.current = serialized;
    if (localSyncTimerRef.current !== null) return;
    localSyncTimerRef.current = window.setTimeout(() => {
      localSyncTimerRef.current = null;
      const currentMap = elementMapRef.current;
      const pendingElements = latestLocalElementsRef.current;
      if (!currentMap || !pendingElements) return;
      latestLocalElementsRef.current = null;
      const changed = pendingElements.filter(({ id, data }) => currentMap.get(id) !== data);
      const currentDoc = docRef.current;
      if (changed.length === 0 || !currentDoc) return;
      currentDoc.transact(() => {
        for (const { id, data } of changed) currentMap.set(id, data);
      }, localUpdateOrigin);
    }, 100);
  }

  function handlePointerUpdate({ pointer, button }: PointerUpdate) {
    if (!canEditRef.current) return;
    const provider = providerRef.current;
    if (!provider?.awareness) return;
    latestPointerRef.current = { pointer, button };
    if (pointerTimerRef.current !== null) return;
    pointerTimerRef.current = window.setTimeout(() => {
      pointerTimerRef.current = null;
      const latestPointer = latestPointerRef.current;
      if (!latestPointer) return;
      provider.awareness?.setLocalStateField("pointer", latestPointer.pointer);
      provider.awareness?.setLocalStateField("button", latestPointer.button);
    }, 100);
  }

  return (
    <div className="classroom-whiteboard-content">
      <div aria-live="polite" className={`classroom-board-status status-${connection === "Connected" ? "connected" : connection === "Offline" ? "offline" : "reconnecting"}`}>
        {connection}
      </div>
      {error ? (
        <div className="classroom-board-error" role="alert">
          <strong>Could not connect to the board</strong>
          <button onClick={() => setAttempt((value) => value + 1)} type="button">Retry</button>
        </div>
      ) : loading ? (
        <div className="classroom-whiteboard-loading">Connecting to board…</div>
      ) : (
        <Excalidraw
          excalidrawAPI={(api) => {
            apiRef.current = api;
            applyRemoteSceneRef.current();
          }}
          onChange={handleChange}
          onPointerUpdate={handlePointerUpdate}
          theme="light"
          UIOptions={{
            canvasActions: {
              clearCanvas: false,
              export: false,
              loadScene: false,
              saveToActiveFile: false,
              saveAsImage: false,
              toggleTheme: false,
            },
            welcomeScreen: false,
          }}
          viewModeEnabled={!canEdit}
          renderTopRightUI={() => null}
        />
      )}
    </div>
  );
}
