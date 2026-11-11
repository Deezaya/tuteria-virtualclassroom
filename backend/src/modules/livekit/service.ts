import { AccessToken } from "livekit-server-sdk";
import type { Participant } from "@prisma/client";
import { config } from "../../config.js";
import {
  allowedTrackSources,
  readPermissions,
} from "../sessions/permissions.js";

type TokenParticipant = Pick<
  Participant,
  "id" | "displayName" | "classRole" | "status" | "permissions" | "breakoutRoomId"
> & {
  session: {
    id: string;
    endedAt: Date | null;
    spaceId: string;
  };
};

export async function createParticipantToken(
  participant: TokenParticipant,
  options: { roomName?: string; hidden?: boolean } = {},
) {
  const permissions = readPermissions(participant.permissions);
  const canPublishSources = allowedTrackSources(permissions);
  const roomName =
    options.roomName ??
    (participant.breakoutRoomId
      ? `${participant.session.id}:${participant.breakoutRoomId}`
      : participant.session.id);
  const hidden = options.hidden === true;
  const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: participant.id,
    ...(participant.classRole === "observer" || hidden
      ? {}
      : {
          name: participant.displayName ?? undefined,
          metadata: JSON.stringify({ role: participant.classRole }),
        }),
    ttl: "10m",
  });

  if (participant.classRole === "admin" || participant.classRole === "tutor") {
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: !hidden && canPublishSources.length > 0,
      ...(!hidden ? { canPublishSources } : {}),
      canPublishData: !hidden && permissions.chat,
      canSubscribe: true,
      ...(!hidden ? { roomAdmin: true } : {}),
    });
  } else if (participant.classRole === "observer" || hidden) {
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: false,
      canPublishData: false,
      canSubscribe: true,
      hidden: true,
    });
  } else {
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: canPublishSources.length > 0,
      canPublishSources,
      canPublishData: permissions.chat,
      canSubscribe: true,
    });
  }

  // Live permission changes can be sent with LiveKit's UpdateParticipant here.
  return token.toJwt();
}

export type { TokenParticipant };
