import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { DriveEntry, IceServerConfig } from "@sync-seat/shared";
import { EnvConfig } from "../config/env.js";
import { logInfo } from "../logging/app-logger.js";
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
    logInfo("AlistController", "REST 请求目录列表", { path });
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
    logInfo("AlistController", "REST 请求同目录字幕", { videoPath });
    return this.alist.listSubtitlesNearVideo(videoPath);
  }

  /**
   * 返回房主推流 WebRTC ICE 配置。
   *
   * @returns 浏览器可用的 STUN 和临时 TURN server 列表。
   */
  @Get("ice-servers")
  iceServers(): IceServerConfig[] {
    const servers = this.env.getIceServers();
    logInfo("AlistController", "REST 请求 ICE 配置", { serverCount: servers.length });
    return servers;
  }

  /**
   * 返回语音专用 WebRTC ICE 配置。
   *
   * @returns 只包含临时 TURN server，不包含 STUN。
   */
  @Get("voice-ice-servers")
  voiceIceServers(): IceServerConfig[] {
    const servers = this.env.getVoiceIceServers();
    logInfo("AlistController", "REST 请求语音 ICE 配置", { serverCount: servers.length });
    return servers;
  }

  /**
   * 返回客户端真实 IP，用于修复 Chrome mDNS 隐藏导致的局域网 ICE 连接失败。
   *
   * @param req Express 请求对象，trust proxy 后 req.ip 为真实客户端 IP。
   */
  @Get("whoami")
  whoami(@Req() req: Request): { ip: string } {
    // trust proxy 后 req.ip 为代理转发的真实客户端 IP，去掉 IPv4-mapped IPv6 前缀
    const ip = (req.ip ?? "unknown").replace(/^::ffff:/i, "");
    logInfo("AlistController", "REST 请求客户端真实 IP", { ip });
    return { ip };
  }
}
