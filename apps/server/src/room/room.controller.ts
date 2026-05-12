import { Body, Controller, Get, Header, Param, Post } from "@nestjs/common";
import type { CreateRoomRequest, CreateRoomResponse, JoinRoomRequest, RoomState } from "@sync-seat/shared";
import { SubtitleService } from "../drive/subtitle.service.js";
import { RoomService } from "./room.service.js";

/**
 * 房间 REST API。
 *
 * @author 清羽
 */
@Controller("api/rooms")
export class RoomController {
  constructor(
    private readonly rooms: RoomService,
    private readonly subtitles: SubtitleService
  ) {}

  /**
   * 创建空房间。
   *
   * @param body 创建请求。
   * @returns 房间状态和邀请链接。
   */
  @Post()
  create(@Body() body: CreateRoomRequest): CreateRoomResponse {
    const room = this.rooms.createRoom(body.memberId, body.nickname, body.password, body.watchMode);
    return {
      room,
      inviteUrl: `/room/${room.roomCode}`
    };
  }

  /**
   * 加入房间。
   *
   * @param roomCode 房间码。
   * @param body 加入请求。
   * @returns 最新房间状态。
   */
  @Post(":roomCode/join")
  join(@Param("roomCode") roomCode: string, @Body() body: JoinRoomRequest): RoomState {
    return this.rooms.joinRoom(roomCode, body.memberId, body.nickname, body.password).room;
  }

  /**
   * 查询房间状态。
   *
   * @param roomCode 房间码。
   * @returns 当前房间状态。
   */
  @Get(":roomCode")
  get(@Param("roomCode") roomCode: string): RoomState {
    return this.rooms.getRoom(roomCode);
  }

  /**
   * 输出当前字幕的 WebVTT 内容。
   *
   * @param roomCode 房间码。
   * @returns WebVTT 字幕。
   */
  @Get(":roomCode/subtitle.vtt")
  @Header("content-type", "text/vtt; charset=utf-8")
  async subtitle(@Param("roomCode") roomCode: string): Promise<string> {
    const subtitle = this.rooms.getCurrentSubtitle(roomCode);
    if (!subtitle) {
      return "WEBVTT\n\n";
    }
    return this.subtitles.readAsVtt(subtitle.filePath);
  }
}
