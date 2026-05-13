import { Readable } from "node:stream";
import { Body, Controller, Get, Headers, Param, Post, Res } from "@nestjs/common";
import type { CreateRoomRequest, CreateRoomResponse, JoinRoomRequest, RoomState } from "@sync-seat/shared";
import type { Response as ExpressResponse } from "express";
import { SubtitleService } from "../drive/subtitle.service.js";
import { logInfo } from "../logging/app-logger.js";
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
    logInfo("RoomController", "REST 创建房间完成", {
      roomCode: room.roomCode,
      memberId: body.memberId,
      watchMode: room.watchMode
    });
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
    const result = this.rooms.joinRoom(roomCode, body.memberId, body.nickname, body.password);
    logInfo("RoomController", "REST 加入房间完成", {
      roomCode: result.room.roomCode,
      memberId: body.memberId,
      reconnected: result.reconnected
    });
    return result.room;
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
  async video(@Param("roomCode") roomCode: string, @Headers("range") range: string | undefined, @Res() response: ExpressResponse): Promise<void> {
    const abortController = new AbortController();
    const abortUpstream = () => {
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    };
    const cleanupAbortHooks = () => {
      response.req.off("aborted", abortUpstream);
      response.off("close", abortUpstream);
      response.off("finish", cleanupAbortHooks);
    };

    response.req.once("aborted", abortUpstream);
    response.once("close", abortUpstream);
    response.once("finish", cleanupAbortHooks);

    let upstream: globalThis.Response;
    try {
      upstream = await this.rooms.openCurrentVideoStream(roomCode, range, abortController.signal);
    } catch (err) {
      cleanupAbortHooks();
      if (abortController.signal.aborted) {
        return;
      }
      throw err;
    }
    if (abortController.signal.aborted) {
      cleanupAbortHooks();
      upstream.body?.cancel().catch(() => undefined);
      return;
    }
    logInfo("RoomController", "代理当前视频内容", {
      roomCode,
      statusCode: upstream.status,
      hasRange: Boolean(range)
    });
    response.status(upstream.status);
    for (const header of ["accept-ranges", "cache-control", "content-length", "content-range", "content-type", "etag", "last-modified"]) {
      const value = upstream.headers.get(header);
      if (value) {
        response.setHeader(header, value);
      }
    }
    if (!upstream.body) {
      cleanupAbortHooks();
      response.end();
      return;
    }
    const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>);
    response.once("close", () => {
      cleanupAbortHooks();
      if (!response.writableEnded) {
        stream.destroy();
        upstream.body?.cancel().catch(() => undefined);
      }
    });
    stream.on("error", () => {
      if (!response.headersSent) {
        response.status(502).end();
      } else {
        response.destroy();
      }
    });
    stream.on("end", cleanupAbortHooks);
    stream.pipe(response);
  }

  /**
   * 输出当前字幕的 WebVTT 内容。
   *
   * @param roomCode 房间码。
   * @returns WebVTT 字幕。
   */
  @Get(":roomCode/subtitle.vtt")
  async subtitle(@Param("roomCode") roomCode: string, @Res() response: ExpressResponse): Promise<void> {
    const subtitle = this.rooms.getCurrentSubtitle(roomCode);
    if (!subtitle) {
      logInfo("RoomController", "房间未选择字幕，返回空 WebVTT", { roomCode });
      response.type("text/vtt; charset=utf-8").send("WEBVTT\n\n");
      return;
    }
    const content = await this.subtitles.readAsVtt(subtitle.filePath);
    logInfo("RoomController", "输出当前字幕 WebVTT", {
      roomCode,
      filePath: subtitle.filePath,
      fileName: subtitle.fileName
    });
    response.type("text/vtt; charset=utf-8").send(content);
  }
}
