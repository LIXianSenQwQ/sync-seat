import { Injectable } from "@nestjs/common";
import type { RoomState } from "@sync-seat/shared";

/**
 * WebSocket 房间连接索引。
 *
 * @author 清羽
 */
@Injectable()
export class RealtimeService {
  private readonly memberSockets = new Map<string, { roomCode: string; memberId: string }>();
  private readonly socketsByMember = new Map<string, Set<string>>();

  bind(socketId: string, roomCode: string, memberId: string): void {
    const normalizedRoomCode = roomCode.toUpperCase();
    this.memberSockets.set(socketId, { roomCode: normalizedRoomCode, memberId });
    const key = this.memberKey(normalizedRoomCode, memberId);
    const sockets = this.socketsByMember.get(key) ?? new Set<string>();
    sockets.add(socketId);
    this.socketsByMember.set(key, sockets);
  }

  unbind(socketId: string): { roomCode: string; memberId: string } | null {
    const binding = this.memberSockets.get(socketId) ?? null;
    this.memberSockets.delete(socketId);
    if (binding) {
      const key = this.memberKey(binding.roomCode, binding.memberId);
      const sockets = this.socketsByMember.get(key);
      sockets?.delete(socketId);
      if (sockets?.size === 0) {
        this.socketsByMember.delete(key);
      }
    }
    return binding;
  }

  roomName(roomCode: string): string {
    return `room:${roomCode.toUpperCase()}`;
  }

  stateEvent(room: RoomState): { type: "room_state"; room: RoomState } {
    return { type: "room_state", room };
  }

  targetSocketIds(roomCode: string, memberId: string): string[] {
    return [...(this.socketsByMember.get(this.memberKey(roomCode.toUpperCase(), memberId)) ?? [])];
  }

  private memberKey(roomCode: string, memberId: string): string {
    return `${roomCode}:${memberId}`;
  }
}
