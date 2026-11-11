import { DataPacket_Kind, RoomServiceClient } from "livekit-server-sdk";
import { config } from "../../config.js";

const liveKitRoomService = new RoomServiceClient(
  config.LIVEKIT_URL,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

export async function publishBreakoutEvent(
  sessionId: string,
  roomIds: string[],
  event: Record<string, unknown>,
): Promise<void> {
  const roomNames = [...new Set([sessionId, ...roomIds.map((id) => `${sessionId}:${id}`)])];
  const existingRooms = await liveKitRoomService.listRooms(roomNames);
  const payload = Buffer.from(JSON.stringify(event));
  await Promise.all(
    existingRooms.map((room) =>
      liveKitRoomService.sendData(room.name, payload, DataPacket_Kind.RELIABLE, {
        topic: "breakouts",
      }),
    ),
  );
}
