import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { BoardSurface } from "./BoardSurface";
import type { BoardModel } from "./model/BoardModel";
import type { Leading } from "./model/schema";
import { createAssetService } from "./sync/assetService";
import { useBoardPair } from "./sync/useBoardPair";
import type { BoardProps } from "./types";
import "./board.css";

const noSubscribe = () => () => undefined;

/** Leading Mode as stored in the board's locked layer. */
function useLeading(model: BoardModel | null): Leading | null {
  const subscribe = useCallback(
    (listener: () => void) => (model ? model.subscribe(listener) : noSubscribe()),
    [model],
  );
  return useSyncExternalStore(subscribe, () => model?.getLeading() ?? null);
}

/** The custom whiteboard. Loaded only when VITE_BOARD_ENGINE=tuteria. */
export default function TuteriaWhiteboard({
  canEdit,
  canUpload = false,
  classRole,
  displayName,
  sessionId,
  roomId,
  spyMode,
}: BoardProps) {
  const isHost = classRole === "admin" || classRole === "tutor";
  const editable = canEdit && !spyMode;
  const urlListeners = useRef(new Set<() => void>());
  const assets = useMemo(
    () => createAssetService(sessionId, () => urlListeners.current.forEach((listener) => listener())),
    [sessionId],
  );
  const subscribeUrls = useCallback((listener: () => void) => {
    urlListeners.current.add(listener);
    return () => {
      urlListeners.current.delete(listener);
    };
  }, []);

  // The board's two documents: the main one and its locked layer.
  const pair = useBoardPair({
    classRole,
    displayName,
    roomId,
    sessionId,
    spyMode,
    presence: true,
    canWriteMain: editable,
    canWriteLocked: editable && isHost,
  });
  const leading = useLeading(pair.locked);

  return (
    <BoardSurface
      assets={assets}
      canEdit={editable}
      canUpload={canUpload}
      displayName={displayName}
      isHost={isHost}
      leading={leading}
      offerLead={isHost && !spyMode}
      pair={pair}
      subscribeUrls={subscribeUrls}
    />
  );
}
