import { EventEmitter } from "node:events";

export type JoinStatusEvent = "admitted" | "denied" | "removed";
export type SessionEvent = { type: "session-ended" };

const joinEvents = new EventEmitter();
joinEvents.setMaxListeners(0);
const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(0);

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

export function subscribeToSessionEvents(
  sessionId: string,
  listener: (event: SessionEvent) => void,
): () => void {
  const eventName = `session:${sessionId}`;
  sessionEvents.on(eventName, listener);
  return () => sessionEvents.off(eventName, listener);
}

export function emitSessionEvent(sessionId: string, event: SessionEvent): void {
  sessionEvents.emit(`session:${sessionId}`, event);
}
