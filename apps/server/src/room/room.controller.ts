import { Readable } from "node:stream";
import { Body, Controller, Get, Headers, Param, Post, Res } from "@nestjs/common";
import type { CreateRoomRequest, CreateRoomResponse, JoinRoomRequest, RoomState } from "@sync-seat/shared";
import type { Response } from "express";
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
   * 代理房间当前视频内容，避免浏览器直接访问内网 AList/OpenList 地址。
   *
   * @param roomCode 房间码。
   * @param range 浏览器 Range 请求头。
   * @param response Express 响应对象。
   */
  @Get(":roomCode/video")
  async video(@Param("roomCode") roomCode: string, @Headers("range") range: string | undefined, @Res() response: Response): Promise<void> {
    const upstream = await this.rooms.openCurrentVideoStream(roomCode, range);
    response.status(upstream.status);
    for (const header of ["accept-ranges", "cache-control", "content-length", "content-range", "content-type", "etag", "last-modified"]) {
      const value = upstream.headers.get(header);
      if (value) {
        response.setHeader(header, value);
      }
    }
    if (!upstream.body) {
      response.end();
      return;
    }
    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>).pipe(response);
  }

  /**
   * 输出当前字幕的 WebVTT 内容。
   *
   * @param roomCode 房间码。
   * @returns WebVTT 字幕。
   */
  @Get(":roomCode/subtitle.vtt")
  async subtitle(@Param("roomCode") roomCode: string, @Res() response: Response): Promise<void> {
    const subtitle = this.rooms.getCurrentSubtitle(roomCode);
    if (!subtitle) {
      response.type("text/vtt; charset=utf-8").send("WEBVTT\n\n");
      return;
    }
    const content = await this.subtitles.readAsVtt(subtitle.filePath);
    response.type("text/vtt; charset=utf-8").send(content);
  }
}
