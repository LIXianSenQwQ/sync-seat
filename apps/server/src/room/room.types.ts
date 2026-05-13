import type { RoomMember, RoomState } from "@sync-seat/shared";

export interface StoredRoom extends RoomState {
  passwordHash: string | null;
  ownerDisconnectedAt: string | null;
  memberOrder: string[];
}

export interface JoinResult {
  room: RoomState;
  reconnected: boolean;
}

export type PublicRoom = Omit<StoredRoom, "passwordHash" | "ownerDisconnectedAt" | "memberOrder">;

export function clonePublicRoom(room: StoredRoom): PublicRoom {
  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    watchMode: room.watchMode,
    hasPassword: Boolean(room.passwordHash),
    ownerId: room.ownerId,
    members: room.members.map((member: RoomMember) => ({ ...member })),
    currentVideo: room.currentVideo ? { ...room.currentVideo } : null,
    currentSubtitle: room.currentSubtitle ? { ...room.currentSubtitle } : null,
    playbackState: { ...room.playbackState },
    hostStreamState: room.hostStreamState ? { ...room.hostStreamState } : null,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    emptySince: room.emptySince,
    maxMembers: room.maxMembers
  };
}
