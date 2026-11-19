import { FileUp, Trash2 } from "lucide-react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
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
import { useRef, useState } from "react";
import * as Y from "yjs";
import {
  maxPdfPages,
  openPdf,
  parsePageRange,
  rasterizePdfPage,
} from "./board/pdf/rasterizePdf";
import { useBoardConnection } from "./board/sync/useBoardConnection";
import type { BoardProps } from "./board/types";
import "@excalidraw/excalidraw/index.css";

type SerializedElement = { id: string; data: string };
type PointerUpdate = {
  pointer: { x: number; y: number; tool: "pointer" | "laser" };
  button: "down" | "up";
};

const elementMapName = "elements";
const fileMapName = "files";
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
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const applyRemoteSceneRef = useRef<() => void>(() => undefined);
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

  const { connection, docRef, error, loading, providerRef, retry } = useBoardConnection(
    { classRole, displayName, roomId, sessionId, spyMode },
    ({ getProvider }) => {
      let doc: Y.Doc | null = null;
      let elements: Y.Map<string> | null = null;
      let fileMap: Y.Map<string> | null = null;
      let onFilesChange:
        | ((event: Y.YMapEvent<string>, transaction: Y.Transaction) => void)
        | null = null;
      let onElementsChange:
        | ((event: Y.YMapEvent<string>, transaction: Y.Transaction) => void)
        | null = null;

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
        const provider = getProvider();
        currentApi.updateScene({
          elements: reconciledElements,
          collaborators: provider ? getCollaborators(doc, provider) : new Map(),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      function updateCollaborators() {
        const currentApi = apiRef.current;
        const provider = getProvider();
        if (!currentApi || !doc || !provider) return;
        currentApi.updateScene({
          collaborators: getCollaborators(doc, provider),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }

      applyRemoteSceneRef.current = applyRemoteScene;

      return {
        attach(newDoc) {
          doc = newDoc;
          elements = newDoc.getMap<string>(elementMapName);
          elementMapRef.current = elements;
          onElementsChange = (_event, transaction) => {
            if (transaction.origin !== localUpdateOrigin) applyRemoteScene();
          };
          elements.observe(onElementsChange);
          fileMap = newDoc.getMap<string>(fileMapName);
          fileMapRef.current = fileMap;
          onFilesChange = (_event, transaction) => {
            if (transaction.origin !== localUpdateOrigin) applyRemoteFiles();
          };
          fileMap.observe(onFilesChange);
        },
        onAwarenessChange: updateCollaborators,
        onSync: applyRemoteScene,
        detach() {
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
        },
        release() {
          if (elementMapRef.current === elements) elementMapRef.current = null;
          if (fileMapRef.current === fileMap) fileMapRef.current = null;
          applyRemoteSceneRef.current = () => undefined;
          apiRef.current = null;
        },
      };
    },
  );

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
      const pdf = await openPdf(file);
      const answer = window.prompt(
        `This PDF has ${pdf.numPages} pages. Which pages do you want to add? (example: 1-20 or 21-40). Up to ${maxPdfPages} at a time.`,
        `1-${Math.min(pdf.numPages, maxPdfPages)}`,
      );
      if (answer === null) {
        await pdf.destroy();
        return;
      }
      const { firstPage, lastPage } = parsePageRange(answer, pdf.numPages);
      const existing = api.getSceneElementsIncludingDeleted().filter((el) => !el.isDeleted);
      let nextY =
        existing.length > 0 ? Math.max(...existing.map((el) => el.y + el.height)) + 60 : 0;
      const binaryFiles: BinaryFileData[] = [];
      const skeletons: Skeleton[] = [];

      for (let number = firstPage; number <= lastPage; number += 1) {
        const page = await rasterizePdfPage(pdf, number);
        const id = crypto.randomUUID() as FileId;
        binaryFiles.push({
          id,
          mimeType: "image/jpeg",
          dataURL: page.dataURL as BinaryFileData["dataURL"],
          created: Date.now(),
        });
        const height = Math.round((pdfPageWidth * page.height) / page.width);
        skeletons.push({
          type: "image",
          fileId: id,
          status: "saved",
          x: 0,
          y: nextY,
          width: pdfPageWidth,
          height,
          locked: true,
          customData: { pdfPage: true },
        });
        nextY += height + 24;
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
          <button onClick={retry} type="button">Retry</button>
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
