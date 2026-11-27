import type { HocuspocusProvider } from "@hocuspocus/provider";
import { useCallback, useRef, useState } from "react";
import { BoardModel } from "../model/BoardModel";
import type { ClassRole } from "../types";
import { colorForParticipant } from "./presence";
import { useBoardConnection, type BoardConnectionStatus } from "./useBoardConnection";

export type BoardPairOptions = {
  classRole: ClassRole;
  displayName: string;
  roomId: string | null;
  sessionId: string;
  spyMode: boolean;
  /** Announce this person (name, cursor colour, participant id) on the main document. */
  presence: boolean;
  /** May write, for the version check of an empty board. */
  canWriteMain: boolean;
  canWriteLocked: boolean;
};

/** A board's two documents: the main one and its locked layer. */
export type BoardPair = {
  main: BoardModel | null;
  locked: BoardModel | null;
  /** This person's participant id, from the board token. */
  participantId: string | null;
  /** The main document's provider; presence travels on it. */
  getProvider(): HocuspocusProvider | null;
  /** Called on every presence change on the main document. */
  subscribeAwareness(listener: () => void): () => void;
  /**
   * Called just before a document is closed, while it is still alive, so a
   * stroke being drawn can be finished and saved.
   */
  subscribeDetach(listener: (model: BoardModel) => void): () => void;
  connection: BoardConnectionStatus;
  error: boolean;
  loading: boolean;
  retry(): void;
};

/**
 * Connects to both documents of one board over the page's shared board
 * websocket. The server decides who may write each one.
 */
export function useBoardPair(options: BoardPairOptions): BoardPair {
  const { classRole, displayName, roomId, sessionId, spyMode, presence } = options;
  const [main, setMain] = useState<BoardModel | null>(null);
  const [locked, setLocked] = useState<BoardModel | null>(null);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const canWrite = useRef({ main: options.canWriteMain, locked: options.canWriteLocked });
  canWrite.current = { main: options.canWriteMain, locked: options.canWriteLocked };
  const awarenessListeners = useRef(new Set<() => void>());
  const detachListeners = useRef(new Set<(model: BoardModel) => void>());
  const announce = presence && classRole !== "observer";

  const notifyAwareness = () => awarenessListeners.current.forEach((listener) => listener());
  const notifyDetach = (model: BoardModel) => detachListeners.current.forEach((listener) => listener(model));

  const mainConnection = useBoardConnection(
    { classRole, displayName, roomId, sessionId, spyMode, presence: announce, shared: true },
    ({ getProvider }) => {
      let model: BoardModel | null = null;
      return {
        attach(doc, session) {
          model = new BoardModel(doc, session.participantId);
          setMain(model);
          setParticipantId(session.participantId);
        },
        onAwarenessChange: notifyAwareness,
        onSync() {
          const provider = getProvider();
          if (announce && provider?.awareness && model) {
            provider.awareness.setLocalStateField("color", colorForParticipant(model.participantId));
            provider.awareness.setLocalStateField("pid", model.participantId);
          }
          if (model?.getSchemaStatus() === "pending" && provider?.isSynced) {
            model.checkSchema(canWrite.current.main);
          }
          notifyAwareness();
        },
        detach() {
          if (model) notifyDetach(model);
        },
        release() {
          const closing = model;
          model?.destroy();
          model = null;
          setMain((current) => (current === closing ? null : current));
          notifyAwareness();
        },
      };
    },
  );

  const lockedConnection = useBoardConnection(
    { classRole, displayName, roomId, sessionId, spyMode, layer: "locked", presence: false, shared: true },
    ({ getProvider }) => {
      let model: BoardModel | null = null;
      return {
        attach(doc, session) {
          model = new BoardModel(doc, session.participantId);
          setLocked(model);
        },
        onAwarenessChange() {},
        onSync() {
          if (model?.getSchemaStatus() === "pending" && getProvider()?.isSynced) {
            model.checkSchema(canWrite.current.locked);
          }
        },
        detach() {
          if (model) notifyDetach(model);
        },
        release() {
          const closing = model;
          model?.destroy();
          model = null;
          setLocked((current) => (current === closing ? null : current));
        },
      };
    },
  );

  const mainProviderRef = mainConnection.providerRef;
  const getProvider = useCallback(() => mainProviderRef.current, [mainProviderRef]);
  const subscribeAwareness = useCallback((listener: () => void) => {
    awarenessListeners.current.add(listener);
    return () => {
      awarenessListeners.current.delete(listener);
    };
  }, []);
  const subscribeDetach = useCallback((listener: (model: BoardModel) => void) => {
    detachListeners.current.add(listener);
    return () => {
      detachListeners.current.delete(listener);
    };
  }, []);

  const connection: BoardConnectionStatus =
    mainConnection.connection === "Offline" || lockedConnection.connection === "Offline"
      ? "Offline"
      : mainConnection.connection === "Connected" && lockedConnection.connection === "Connected"
        ? "Connected"
        : "Reconnecting…";
  const retryMain = mainConnection.retry;
  const retryLocked = lockedConnection.retry;

  return {
    main,
    locked,
    participantId,
    getProvider,
    subscribeAwareness,
    subscribeDetach,
    connection,
    error: mainConnection.error || lockedConnection.error,
    loading: mainConnection.loading || lockedConnection.loading,
    retry: () => {
      retryMain();
      retryLocked();
    },
  };
}
