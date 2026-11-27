import { Database } from "@hocuspocus/extension-database";
import { Hocuspocus, type Connection, type WebSocketLike } from "@hocuspocus/server";
import crossws from "crossws/adapters/node";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { prisma } from "../../db.js";

type BoardContext = {
  participantId: string;
  classRole: string;
  documentName: string;
  editing: boolean;
  /** Admins and tutors: always allowed to edit their own board. */
  host: boolean;
  /** Spy-mode view of another room's board: always read-only. */
  spy: boolean;
  /** The board's locked layer: only hosts may write. */
  lockedLayer: boolean;
};

type ConnectionEntry = {
  connection: Connection<BoardContext>;
  observer: boolean;
  host: boolean;
  spy: boolean;
  lockedLayer: boolean;
};

/** Suffix of a board's locked-layer document, e.g. `space:{id}:main:locked`. */
export const LOCKED_LAYER_SUFFIX = ":locked";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BoardTokenPayload = {
  sub: string;
  classRole: string;
  editing?: boolean;
  spy?: boolean;
  documentName: string;
  exp: number;
};

const classRoles = new Set(["admin", "tutor", "student", "guest", "observer"]);
const participantConnections = new Map<string, Set<ConnectionEntry>>();

/**
 * Applies a change to a participant's Editing permission to their open
 * board connections. Observers and spy views stay read-only and hosts stay
 * writable, whatever the permission says. A locked layer is writable only
 * by hosts, so the permission never opens it to anyone else.
 */
export function updateBoardParticipantEditing(
  participantId: string,
  editing: boolean,
): void {
  for (const entry of participantConnections.get(participantId) ?? []) {
    entry.connection.readOnly =
      entry.observer ||
      entry.spy ||
      (entry.lockedLayer ? !entry.host : !entry.host && !editing);
  }
}

export function removeBoardParticipant(participantId: string): void {
  const entries = participantConnections.get(participantId);
  if (!entries) return;
  for (const { connection } of [...entries]) {
    connection.close();
    connection.webSocket.close(1008, "Removed from class");
  }
}

export function createBoardServer(app: FastifyInstance): void {
  const database = new Database({
    async fetch({ documentName }) {
      const board = await prisma.board.findUnique({
        where: { name: documentName },
        select: { data: true },
      });
      return board?.data ?? null;
    },
    async store({ documentName, state }) {
      const data = Buffer.from(state);
      await prisma.board.upsert({
        where: { name: documentName },
        create: { name: documentName, data },
        update: { data },
      });
    },
  });

  const hocuspocus = new Hocuspocus<BoardContext>({
    debounce: 2000,
    maxDebounce: 10000,
    extensions: [database],
    async onAuthenticate({ token, documentName, connectionConfig }) {
      let payload: BoardTokenPayload;
      try {
        payload = await app.jwt.verify<BoardTokenPayload>(token);
      } catch {
        throw new Error("Invalid or expired board token");
      }

      if (
        typeof payload.sub !== "string" ||
        typeof payload.classRole !== "string" ||
        !classRoles.has(payload.classRole) ||
        (payload.editing !== undefined && typeof payload.editing !== "boolean") ||
        (payload.spy !== undefined && typeof payload.spy !== "boolean") ||
        typeof payload.documentName !== "string" ||
        payload.documentName !== documentName ||
        !Number.isInteger(payload.exp) ||
        payload.exp <= Math.floor(Date.now() / 1000)
      ) {
        throw new Error("Invalid or expired board token");
      }

      const participant = await prisma.participant.findUnique({
        where: { id: payload.sub },
        select: {
          classRole: true,
          permissions: true,
          breakoutRoomId: true,
          status: true,
          session: { select: { id: true, endedAt: true, spaceId: true } },
        },
      });
      if (
        !participant ||
        participant.status !== "admitted" ||
        participant.classRole !== payload.classRole ||
        participant.session.endedAt
      ) {
        throw new Error("Participant is no longer admitted to this board");
      }

      // A locked layer follows the same access rules as its board.
      const lockedLayer = documentName.endsWith(LOCKED_LAYER_SUFFIX);
      const boardName = lockedLayer
        ? documentName.slice(0, -LOCKED_LAYER_SUFFIX.length)
        : documentName;
      const host = payload.classRole === "admin" || payload.classRole === "tutor";
      const spy = payload.spy === true;
      const documentRoomId = boardName.startsWith(`${participant.session.id}:`)
        ? boardName.slice(participant.session.id.length + 1)
        : null;
      // Only look up real room ids; anything else can't be a breakout board.
      const documentRoom =
        documentRoomId && UUID_PATTERN.test(documentRoomId)
          ? await prisma.breakoutRoom.findFirst({
              where: {
                id: documentRoomId,
                sessionId: participant.session.id,
              },
              select: { id: true },
            })
          : null;
      const isOwnBoard = participant.breakoutRoomId
        ? documentRoom?.id === participant.breakoutRoomId
        : `space:${participant.session.spaceId}:main` === boardName;
      const isSpyBoard =
        spy &&
        (host || payload.classRole === "observer") &&
        documentRoom !== null;
      if (!isOwnBoard && !isSpyBoard) {
        throw new Error("Participant is no longer admitted to this board");
      }

      const storedPermissions =
        typeof participant.permissions === "object" &&
        participant.permissions !== null &&
        !Array.isArray(participant.permissions)
          ? (participant.permissions as Record<string, unknown>)
          : {};
      // Everyone with Editing writes the board; only hosts write its locked layer.
      const editing =
        payload.editing !== false &&
        !spy &&
        payload.classRole !== "observer" &&
        (lockedLayer
          ? host
          : host ||
            (typeof storedPermissions.editing === "boolean"
              ? storedPermissions.editing
              : true));
      connectionConfig.readOnly = !editing;
      return {
        participantId: payload.sub,
        classRole: payload.classRole,
        documentName: payload.documentName,
        editing,
        host,
        spy,
        lockedLayer,
      };
    },
    async connected({ connection, context }) {
      const entries =
        participantConnections.get(context.participantId) ?? new Set<ConnectionEntry>();
      const entry: ConnectionEntry = {
        connection,
        observer: context.classRole === "observer",
        host: context.host,
        spy: context.spy,
        lockedLayer: context.lockedLayer,
      };
      entries.add(entry);
      participantConnections.set(context.participantId, entries);
      connection.onClose(() => {
        entries.delete(entry);
        if (entries.size === 0) {
          participantConnections.delete(context.participantId);
        }
      });
    },
  });

  const connections = new WeakMap<object, ReturnType<typeof hocuspocus.handleConnection>>();
  const websocketAdapter = crossws({
    hooks: {
      open(peer) {
        const connection = hocuspocus.handleConnection(
          peer.websocket as unknown as WebSocketLike,
          peer.request as Request,
        );
        connections.set(peer, connection);
        (peer.websocket as unknown as { on?: (event: string, listener: () => void) => void })
          .on?.("pong", () => connection.touch());
      },
      message(peer, message) {
        connections.get(peer)?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        connections.get(peer)?.handleClose({
          code: event.code ?? 1000,
          reason: event.reason ?? "",
        });
        connections.delete(peer);
      },
      error(peer, error) {
        app.log.error({ err: error, peerId: peer.id }, "Board WebSocket error.");
      },
    },
  });

  const onUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch (error) {
      app.log.warn({ err: error }, "Rejected malformed board WebSocket URL.");
      socket.destroy();
      return;
    }

    if (pathname !== "/board") {
      socket.destroy();
      return;
    }

    try {
      await hocuspocus.hooks("onUpgrade", {
        request,
        socket,
        head,
        instance: hocuspocus,
      });
      await websocketAdapter.handleUpgrade(request, socket, head);
    } catch (error) {
      app.log.error({ err: error }, "Could not upgrade board WebSocket connection.");
      socket.destroy();
    }
  };

  app.server.on("upgrade", onUpgrade);
  app.addHook("onClose", async () => {
    app.server.off("upgrade", onUpgrade);
    websocketAdapter.closeAll(1001, "Server shutting down", true);
    await new Promise<void>((resolve) => {
      hocuspocus.configuration.extensions.push({
        async afterUnloadDocument({ instance }) {
          if (instance.getDocumentsCount() === 0) resolve();
        },
      });
      if (hocuspocus.getDocumentsCount() === 0) resolve();
      hocuspocus.closeConnections();
      hocuspocus.flushPendingStores();
    });
    await hocuspocus.hooks("onDestroy", { instance: hocuspocus });
  });
}
