import { BadRequestException } from "@nestjs/common";
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { ClientRoomEvent, HostControlCommand } from "@sync-seat/shared";
import type { Server, Socket } from "socket.io";
import { logInfo, logWarn } from "../logging/app-logger.js";
import { RoomService } from "./room.service.js";
import { RealtimeService } from "./realtime.service.js";

/**
 * 房间 WebSocket 网关，承载播放同步与 WebRTC 信令。
 *
 * @author 清羽
 */
@WebSocketGateway({
  cors: {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    credentials: true
  }
})
export class RoomGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly rooms: RoomService,
    private readonly realtime: RealtimeService
  ) {}

  handleConnection(socket: Socket): void {
    // 连接建立后等待客户端显式 join_room，避免错误加入房间。
    logInfo("RoomGateway", "WebSocket 连接建立", { socketId: socket.id });
  }

  handleDisconnect(socket: Socket): void {
    const binding = this.realtime.unbind(socket.id);
    if (!binding) {
      logInfo("RoomGateway", "未绑定房间的 WebSocket 断开", { socketId: socket.id });
      return;
    }
    if (this.realtime.targetSocketIds(binding.roomCode, binding.memberId).length > 0) {
      logInfo("RoomGateway", "成员仍有其他 WebSocket 连接在线", {
        socketId: socket.id,
        roomCode: binding.roomCode,
        memberId: binding.memberId
      });
      return;
    }
    const room = this.rooms.leaveRoom(binding.roomCode, binding.memberId);
    this.server.to(this.realtime.roomName(binding.roomCode)).emit("room_event", this.realtime.stateEvent(room));
  }

  /**
   * 客户端加入房间实时通道。
   *
   * @param body 房间码和成员标识。
   * @param socket 当前连接。
   */
  @SubscribeMessage("join_room")
  async joinRoom(@MessageBody() body: { roomCode: string; memberId: string; nickname?: string }, @ConnectedSocket() socket: Socket): Promise<void> {
    const roomCode = body.roomCode.toUpperCase();
    const existingRoom = this.rooms.getRoom(roomCode);
    if (!existingRoom.members.some((member) => member.memberId === body.memberId)) {
      logWarn("RoomGateway", "拒绝未通过 REST 加入的 WebSocket 绑定", {
        socketId: socket.id,
        roomCode,
        memberId: body.memberId
      });
      socket.emit("room_event", { type: "room_error", message: "请先通过 REST API 加入房间" });
      return;
    }
    const room = this.rooms.reconnectMember(roomCode, body.memberId, body.nickname);
    this.realtime.bind(socket.id, roomCode, body.memberId);
    const roomName = this.realtime.roomName(roomCode);
    await socket.join(roomName);
    // 步骤1：成员实时通道就绪后向整个房间广播，确保成员列表不依赖下一次播放/语音事件才刷新。
    logInfo("RoomGateway", "WebSocket 加入房间", {
      socketId: socket.id,
      roomCode,
      memberId: body.memberId
    });
    this.broadcastState(roomName, room);
  }

  /**
   * 处理房间内的播放、字幕和语音消息。
   *
   * @param event 客户端事件。
   */
  @SubscribeMessage("room_event")
  async roomEvent(@MessageBody() event: ClientRoomEvent): Promise<void> {
    const roomCode = event.roomCode.toUpperCase();
    const roomName = this.realtime.roomName(roomCode);

    // 步骤1：播放与字幕类消息更新服务端权威房间状态。
    if (event.type === "load_video") {
      logInfo("RoomGateway", "收到加载视频事件", { roomCode, memberId: event.memberId, filePath: event.filePath });
      const room = await this.rooms.loadVideo(roomCode, event.filePath);
      this.server.to(roomName).emit("room_event", this.realtime.stateEvent(room));
      return;
    }
    if (event.type === "select_subtitle") {
      logInfo("RoomGateway", "收到切换字幕事件", { roomCode, memberId: event.memberId, filePath: event.filePath });
      const room = this.rooms.selectSubtitle(roomCode, event.filePath);
      this.server.to(roomName).emit("room_event", this.realtime.stateEvent(room));
      return;
    }
    if (event.type === "set_playback") {
      try {
        this.broadcastState(
          roomName,
          this.rooms.updatePlayback(
            roomCode,
            {
              playing: event.playing,
              positionSeconds: event.positionSeconds,
              playbackRate: event.playbackRate
            },
            {
              operationId: event.operationId,
              memberId: event.memberId,
              action: event.action,
              baseVersion: event.baseVersion
            }
          )
        );
      } catch (err) {
        if (err instanceof BadRequestException) {
          logWarn("RoomGateway", "拒绝非法播放倍速", {
            roomCode,
            memberId: event.memberId,
            playbackRate: event.playbackRate
          });
          this.emitRoomError(roomCode, event.memberId, err.message);
          return;
        }
        throw err;
      }
      return;
    }
    if (event.type === "host_stream_start") {
      logInfo("RoomGateway", "收到房主推流开始事件", { roomCode, memberId: event.memberId, fileName: event.fileName });
      this.broadcastState(roomName, this.rooms.startHostStream(roomCode, event.memberId, event.fileName));
      return;
    }
    if (event.type === "host_stream_stop") {
      logInfo("RoomGateway", "收到房主推流停止事件", { roomCode, memberId: event.memberId });
      this.broadcastState(roomName, this.rooms.stopHostStream(roomCode, event.memberId));
      return;
    }
    if (event.type === "host_control_request") {
      const command: { type: "host_control_command"; fromMemberId: string } & HostControlCommand = {
        type: "host_control_command",
        fromMemberId: event.memberId,
        action: event.action,
        positionSeconds: event.positionSeconds,
        playbackRate: event.playbackRate
      };
      for (const socketId of this.realtime.targetSocketIds(roomCode, this.rooms.getOwnerId(roomCode))) {
        this.server.to(socketId).emit("room_event", command);
      }
      logInfo("RoomGateway", "转发房主控制请求", {
        roomCode,
        fromMemberId: event.memberId,
        action: event.action
      });
      return;
    }

    // 步骤2：语音状态改变会广播房间状态；WebRTC offer/answer/ICE 只转发目标成员。
    if (event.type === "voice_join") {
      this.broadcastState(roomName, this.rooms.updateVoice(roomCode, event.memberId, { voiceJoined: true }));
      return;
    }
    if (event.type === "voice_leave") {
      this.broadcastState(roomName, this.rooms.updateVoice(roomCode, event.memberId, { voiceJoined: false, muted: false }));
      return;
    }
    if (event.type === "voice_mute") {
      this.broadcastState(roomName, this.rooms.updateVoice(roomCode, event.memberId, { muted: event.muted }));
      return;
    }
    if (event.type === "voice_offer" || event.type === "voice_answer" || event.type === "voice_ice_candidate") {
      const signal = {
        type: "voice_signal",
        fromMemberId: event.memberId,
        signalType: event.type === "voice_offer" ? "offer" : event.type === "voice_answer" ? "answer" : "ice_candidate",
        payload: event.type === "voice_ice_candidate" ? event.candidate : event.description
      };
      for (const socketId of this.realtime.targetSocketIds(roomCode, event.targetMemberId)) {
        this.server.to(socketId).emit("room_event", signal);
      }
      logInfo("RoomGateway", "转发语音 WebRTC 信令", {
        roomCode,
        fromMemberId: event.memberId,
        targetMemberId: event.targetMemberId,
        signalType: signal.signalType
      });
    }
    if (event.type === "host_stream_offer" || event.type === "host_stream_answer" || event.type === "host_stream_ice_candidate") {
      const signal = {
        type: "host_stream_signal",
        fromMemberId: event.memberId,
        signalType: event.type === "host_stream_offer" ? "offer" : event.type === "host_stream_answer" ? "answer" : "ice_candidate",
        payload: event.type === "host_stream_ice_candidate" ? event.candidate : event.description
      };
      for (const socketId of this.realtime.targetSocketIds(roomCode, event.targetMemberId)) {
        this.server.to(socketId).emit("room_event", signal);
      }
      logInfo("RoomGateway", "转发房主推流 WebRTC 信令", {
        roomCode,
        fromMemberId: event.memberId,
        targetMemberId: event.targetMemberId,
        signalType: signal.signalType
      });
    }
  }

  private broadcastState(roomName: string, room: ReturnType<RoomService["getRoom"]>): void {
    this.server.to(roomName).emit("room_event", this.realtime.stateEvent(room));
  }

  private emitRoomError(roomCode: string, memberId: string, message: string): void {
    for (const socketId of this.realtime.targetSocketIds(roomCode, memberId)) {
      this.server.to(socketId).emit("room_event", { type: "room_error", message });
    }
  }
}
