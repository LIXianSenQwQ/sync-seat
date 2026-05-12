import type { ClientRoomEvent, RoomState, ServerRoomEvent } from "@sync-seat/shared";
import { io, type Socket } from "socket.io-client";

/**
 * 房间实时连接封装。
 *
 * @author 清羽
 */
export class RoomSocket {
  private socket: Socket | null = null;

  connect(
    roomCode: string,
    memberId: string,
    onState: (room: RoomState) => void,
    onVoiceSignal: (event: Extract<ServerRoomEvent, { type: "voice_signal" }>) => void,
    onHostStreamSignal: (event: Extract<ServerRoomEvent, { type: "host_stream_signal" }>) => void,
    onHostControl: (event: Extract<ServerRoomEvent, { type: "host_control_command" }>) => void,
    onClosed: (reason: string) => void,
    onError: (message: string) => void
  ): void {
    this.socket = io("/", {
      transports: ["websocket"]
    });

    // 步骤1：连接成功后显式加入房间实时通道。
    this.socket.on("connect", () => {
      this.socket?.emit("join_room", { roomCode, memberId });
    });

    // 步骤2：统一处理服务端房间事件。
    this.socket.on("room_event", (event: ServerRoomEvent) => {
      if (event.type === "room_state") onState(event.room);
      if (event.type === "voice_signal") onVoiceSignal(event);
      if (event.type === "host_stream_signal") onHostStreamSignal(event);
      if (event.type === "host_control_command") onHostControl(event);
      if (event.type === "room_closed") onClosed(event.reason);
      if (event.type === "room_error") onError(event.message);
    });
  }

  send(event: ClientRoomEvent): void {
    this.socket?.emit("room_event", event);
  }

  close(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}
