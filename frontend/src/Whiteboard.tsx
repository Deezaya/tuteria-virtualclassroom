import { FileUp, Trash2 } from "lucide-react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  reconcileElements,
} from "@excalidraw/excalidraw";
import type {
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type {
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
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
  roomId: string | null;
  spyMode: boolean;
};
type SerializedElement = { id: string; data: string };
type PointerUpdate = {
  pointer: { x: number; y: number; tool: "pointer" | "laser" };
  button: "down" | "up";
};

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
const elementMapName = "elements";
const fileMapName = "files";
const maxPdfPages = 20;
const pdfPageWidth = 800;

type Skeleton = NonNullable<
  Parameters<typeof convertToExcalidrawElements>[0]
>[number];

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

export default function Whiteboard({
  canEdit,
  classRole,
  displayName,
  sessionId,
  roomId,
  spyMode,
}: BoardProps) {
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [connection, setConnection] = useState<BoardConnection>("Reconnecting…");
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const applyRemoteSceneRef = useRef<() => void>(() => undefined);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const docRef = useRef<Y.Doc | null>(null);
  const elementMapRef = useRef<Y.Map<string> | null>(null);
  const fileMapRef = useRef<Y.Map<string> | null>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const [hasPdfPages, setHasPdfPages] = useState(false);
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
    let fileMap: Y.Map<string> | null = null;
    let onFilesChange:
      | ((event: Y.YMapEvent<string>, transaction: Y.Transaction) => void)
      | null = null;
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
    function applyRemoteFiles() {
      const currentApi = apiRef.current;
      if (!currentApi || !fileMap) return;
      const known = currentApi.getFiles();
      const missing: BinaryFileData[] = [];
      fileMap.forEach((raw, id) => {
        if (known[id]) return;
        try {
          missing.push(JSON.parse(raw) as BinaryFileData);
        } catch {
          return;
        }
      });
      if (missing.length > 0) currentApi.addFiles(missing);
    }
    function applyRemoteScene() {
      const currentApi = apiRef.current;
      if (!currentApi || !elements || !doc) return;
        applyRemoteFiles();
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
      if (fileMap && onFilesChange) fileMap.unobserve(onFilesChange);
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
      if (fileMapRef.current === fileMap) fileMapRef.current = null;
      applyRemoteSceneRef.current = () => undefined;
      apiRef.current = null;
    }

    async function connect() {
      try {
        const credentials = await getBoardToken(sessionId, {
          ...(roomId ? { roomId } : {}),
          ...(spyMode ? { spy: true } : {}),
        });
        if (!active) return;

        doc = new Y.Doc();
        elements = doc.getMap<string>(elementMapName);
        docRef.current = doc;
        elementMapRef.current = elements;
        onElementsChange = (_event, transaction) => {
          if (transaction.origin !== localUpdateOrigin) applyRemoteScene();
        };
        if (onElementsChange) elements.observe(onElementsChange);
        fileMap = doc.getMap<string>(fileMapName);
        fileMapRef.current = fileMap;
        onFilesChange = (_event, transaction) => {
          if (transaction.origin !== localUpdateOrigin) applyRemoteFiles();
        };
        fileMap.observe(onFilesChange);

        provider = new HocuspocusProvider({
          url: boardWsUrl,
          name: credentials.documentName,
          document: doc,
          token: async () => {
            const refreshed = await getBoardToken(sessionId, {
              ...(roomId ? { roomId } : {}),
              ...(spyMode ? { spy: true } : {}),
            });
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
  }, [attempt, classRole, displayName, roomId, sessionId, spyMode]);

  function handleChange(
    elements: readonly OrderedExcalidrawElement[],
    _appState: unknown,
    files: BinaryFiles,
  ) {
    if (!canEditRef.current || !elementMapRef.current) return;
    setHasPdfPages(
      elements.some((element) => !element.isDeleted && Boolean(element.customData?.pdfPage)),
    );    
    const fileMap = fileMapRef.current;
    const currentDoc = docRef.current;
    if (fileMap && currentDoc) {
      const fresh = Object.values(files).filter((file) => !fileMap.has(file.id));
      if (fresh.length > 0) {
        currentDoc.transact(() => {
          for (const file of fresh) fileMap.set(file.id, JSON.stringify(file));
        }, localUpdateOrigin);
      }
    }
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
  function removePdfPages() {
    const api = apiRef.current;
    if (!api || !window.confirm("Remove all PDF pages from the board?")) return;
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((element) =>
        element.customData?.pdfPage && !element.isDeleted
          ? {
              ...element,
              isDeleted: true,
              version: element.version + 1,
              versionNonce: Math.floor(Math.random() * 2 ** 31),
              updated: Date.now(),
            }
          : element,
      ),
    });
  }
  async function importPdf(file: File) {
    const api = apiRef.current;
    if (!api || pdfBusy) return;
    setPdfBusy(true);
    setPdfError("");
    try {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const pdf = await pdfjs.getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
      }).promise;
      const answer = window.prompt(
        `This PDF has ${pdf.numPages} pages. Which pages do you want to add? (example: 1-20 or 21-40). Up to ${maxPdfPages} at a time.`,
        `1-${Math.min(pdf.numPages, maxPdfPages)}`,
      );
      if (answer === null) {
        await pdf.destroy();
        return;
      }
      const match = answer.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!match) throw new Error("range");
      const firstPage = Math.max(1, Number(match[1]));
      const lastPage = Math.min(
        pdf.numPages,
        Number(match[2] ?? match[1]),
        firstPage + maxPdfPages - 1,
      );
      if (firstPage > lastPage) throw new Error("range");
      const existing = api.getSceneElementsIncludingDeleted().filter((el) => !el.isDeleted);
      let nextY =
        existing.length > 0 ? Math.max(...existing.map((el) => el.y + el.height)) + 60 : 0;
      const binaryFiles: BinaryFileData[] = [];
      const skeletons: Skeleton[] = [];

      for (let number = firstPage; number <= lastPage; number += 1) {
        const page = await pdf.getPage(number);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 1100 / base.width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas is not available.");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;
        const id = crypto.randomUUID() as FileId;
        binaryFiles.push({
          id,
          mimeType: "image/jpeg",
          dataURL: canvas.toDataURL("image/jpeg", 0.78) as BinaryFileData["dataURL"],
          created: Date.now(),
        });
        const height = Math.round((pdfPageWidth * canvas.height) / canvas.width);
        skeletons.push({
          type: "image",
          fileId: id,
          status: "saved",
          x: 0,
          y: nextY,
          width: pdfPageWidth,
          height,
          customData: { pdfPage: true },
        });
        nextY += height + 24;
        page.cleanup();
      }

      api.addFiles(binaryFiles);
      const created = convertToExcalidrawElements(skeletons);
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...created],
      });
      api.scrollToContent(created[0], { fitToViewport: true, viewportZoomFactor: 0.9 });

      await pdf.destroy();
    } catch (cause) {
      setPdfError(
        cause instanceof Error && cause.message === "range"
          ? "Enter pages like 1-20."
          : "Could not read that PDF.",
      );
    } finally {
      setPdfBusy(false);
    }
  }
  return (
    <div className="classroom-whiteboard-content">
      {connection !== "Connected" && (
        <div aria-live="polite" className={`classroom-board-status status-${connection === "Offline" ? "offline" : "reconnecting"}`}>
          {connection}
        </div>
      )}
      {canEdit && !spyMode && !loading && !error && (classRole === "admin" || classRole === "tutor") && (
        <>
          <input
            accept="application/pdf"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importPdf(file);
            }}
            ref={pdfInputRef}
            type="file"
          />

          {pdfError && <span className="classroom-board-pdf-error" role="alert">{pdfError}</span>}
        </>
      )}
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
          renderTopRightUI={() =>
            canEdit && !spyMode && (classRole === "admin" || classRole === "tutor") ? (
              <div className="classroom-board-pdf-actions">
                <button
                  aria-label="Add PDF"
                  className="classroom-board-pdf-icon"
                  disabled={pdfBusy}
                  onClick={() => pdfInputRef.current?.click()}
                  title={pdfBusy ? "Adding PDF…" : "Add PDF"}
                  type="button"
                >
                  <FileUp aria-hidden="true" size={18} />
                </button>
                {hasPdfPages && (
                  <button
                    aria-label="Remove PDF"
                    className="classroom-board-pdf-icon"
                    onClick={removePdfPages}
                    title="Remove PDF pages"
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={18} />
                  </button>
                )}
              </div>
            ) : null
          }
        />
      )}
    </div>
  );
}
