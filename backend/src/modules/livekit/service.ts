import { AccessToken } from "livekit-server-sdk";
import type { Participant } from "@prisma/client";
import { config } from "../../config.js";

type TokenParticipant = Pick<
  Participant,
  "id" | "displayName" | "classRole" | "status"
> & {
  session: {
    id: string;
    endedAt: Date | null;
    spaceId: string;
  };
};

async function getDefaultParticipantPermissions(_spaceId: string) {
  // Placeholder defaults until the settings module provides per-space permissions.
  return { canPublish: true, canPublishData: true };
}

export async function createParticipantToken(participant: TokenParticipant) {
  const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: participant.id,
    ...(participant.classRole === "observer"
      ? {}
      : { name: participant.displayName ?? undefined }),
    ttl: "10m",
  });

  if (participant.classRole === "admin" || participant.classRole === "tutor") {
    token.addGrant({
      room: participant.session.id,
      roomJoin: true,
      canPublish: true,
      canPublishData: true,
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
    const permissions = await getDefaultParticipantPermissions(
      participant.session.spaceId,
    );
    token.addGrant({
      room: participant.session.id,
      roomJoin: true,
      canPublish: permissions.canPublish,
      canPublishData: permissions.canPublishData,
      canSubscribe: true,
    });
  }

  // Live permission changes can be sent with LiveKit's UpdateParticipant here.
  return token.toJwt();
}

export type { TokenParticipant };
