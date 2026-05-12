import { Controller, Get, Query } from "@nestjs/common";
import type { DriveEntry, IceServerConfig } from "@sync-seat/shared";
import { EnvConfig } from "../config/env.js";
import { AlistService } from "./alist.service.js";

/**
 * 网盘浏览 REST API。
 *
 * @author 清羽
 */
@Controller("api/drive")
export class AlistController {
  constructor(
    private readonly alist: AlistService,
    private readonly env: EnvConfig = new EnvConfig()
  ) {}

  /**
   * 获取目录列表。
   *
   * @param path 网盘目录路径。
   * @returns 可展示条目。
   */
  @Get("list")
  list(@Query("path") path = "/"): Promise<DriveEntry[]> {
    return this.alist.listDirectory(path);
  }

  /**
   * 获取同目录字幕。
   *
   * @param videoPath 视频路径。
   * @returns 字幕条目。
   */
  @Get("subtitles")
  subtitles(@Query("videoPath") videoPath: string): Promise<DriveEntry[]> {
    return this.alist.listSubtitlesNearVideo(videoPath);
  }

  /**
   * 返回 WebRTC ICE 配置。
   *
   * @returns 浏览器可用的 ICE server 列表。
   */
  @Get("ice-servers")
  iceServers(): IceServerConfig[] {
    return this.env.getIceServers();
  }
}
