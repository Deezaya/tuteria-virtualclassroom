import { EventEmitter } from "node:events";

export type JoinStatusEvent = "admitted" | "denied" | "removed";

const joinEvents = new EventEmitter();
joinEvents.setMaxListeners(0);

// This emitter is process-local; multiple server instances need Redis or a similar shared event bus.
export function subscribeToJoinStatus(
  participantId: string,
  listener: (status: JoinStatusEvent) => void,
): () => void {
  const eventName = `participant:${participantId}`;
  joinEvents.on(eventName, listener);
  return () => joinEvents.off(eventName, listener);
}

export function emitJoinStatus(
  participantId: string,
  status: JoinStatusEvent,
): void {
  joinEvents.emit(`participant:${participantId}`, status);
}
