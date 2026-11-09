import { AccessToken } from "livekit-server-sdk";
import type { Participant } from "@prisma/client";
import { config } from "../../config.js";
import {
  allowedTrackSources,
  readPermissions,
} from "../sessions/permissions.js";

type TokenParticipant = Pick<
  Participant,
  "id" | "displayName" | "classRole" | "status" | "permissions"
> & {
  session: {
    id: string;
    endedAt: Date | null;
    spaceId: string;
  };
};

export async function createParticipantToken(participant: TokenParticipant) {
  const permissions = readPermissions(participant.permissions);
  const canPublishSources = allowedTrackSources(permissions);
  const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: participant.id,
    ...(participant.classRole === "observer"
      ? {}
      : {
          name: participant.displayName ?? undefined,
          metadata: JSON.stringify({ role: participant.classRole }),
        }),
    ttl: "10m",
  });

  if (participant.classRole === "admin" || participant.classRole === "tutor") {
    token.addGrant({
      room: participant.session.id,
      roomJoin: true,
      canPublish: canPublishSources.length > 0,
      canPublishSources,
      canPublishData: permissions.chat,
      canSubscribe: true,
      roomAdmin: true,
    });
  } else if (participant.classRole === "observer") {
    token.addGrant({
      room: participant.session.id,
      roomJoin: true,
      canPublish: false,
      canPublishData: false,
      canSubscribe: true,
      hidden: true,
    });
  } else {
    token.addGrant({
      room: participant.session.id,
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
