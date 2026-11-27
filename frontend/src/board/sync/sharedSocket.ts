import { HocuspocusProviderWebsocket } from "@hocuspocus/provider";

/**
 * One websocket for every board document the page has open (the board and
 * its locked layer). Hocuspocus sends each document's messages over it, and
 * checks each document's token separately on the server.
 */
let socket: HocuspocusProviderWebsocket | null = null;
let users = 0;

export function acquireBoardSocket(url: string): HocuspocusProviderWebsocket {
  if (!socket) socket = new HocuspocusProviderWebsocket({ url });
  users += 1;
  return socket;
}

/** Call once per acquire, after the provider using it is destroyed. */
export function releaseBoardSocket(): void {
  users = Math.max(0, users - 1);
  if (users === 0 && socket) {
    socket.destroy();
    socket = null;
  }
}
