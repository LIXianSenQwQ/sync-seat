import { Injectable } from "@nestjs/common";
import type { CurrentSubtitle } from "@sync-seat/shared";
import { subtitleFormat } from "./file-kind.js";
import { AlistService } from "./alist.service.js";

/**
 * 字幕读取与格式转换服务。
 *
 * @author 清羽
 */
@Injectable()
export class SubtitleService {
  constructor(private readonly alist: AlistService) {}

  /**
   * 构造房间当前字幕信息。
   *
   * @param filePath 字幕路径。
   * @param roomCode 房间码，用于生成稳定的字幕访问地址。
   * @returns 当前字幕元信息。
   */
  buildCurrentSubtitle(filePath: string, roomCode: string): CurrentSubtitle {
    const format = subtitleFormat(filePath);
    if (!format) {
      throw new Error("不支持的字幕格式");
    }
    return {
      filePath,
      fileName: filePath.split("/").pop() ?? filePath,
      format,
      trackUrl: `/api/rooms/${roomCode}/subtitle.vtt`
    };
  }

  /**
   * 返回浏览器可加载的 WebVTT 内容。
   *
   * @param filePath 字幕路径。
   * @returns WebVTT 文本。
   */
  async readAsVtt(filePath: string): Promise<string> {
    const format = subtitleFormat(filePath);
    const content = await this.alist.readTextFile(filePath);
    if (format === "vtt") {
      return content.trimStart().startsWith("WEBVTT") ? content : `WEBVTT\n\n${content}`;
    }
    return this.srtToVtt(content);
  }

  /**
   * 解析字幕真实访问地址，供已是 WebVTT 的字幕直接 302 跳转。
   *
   * @param filePath 字幕文件路径。
   * @returns AList/OpenList 字幕真实地址。
   */
  async resolveSubtitleUrl(filePath: string): Promise<string> {
    return this.alist.resolveFileUrl(filePath);
  }

  /**
   * 将 SRT 字幕转换成 WebVTT。
   *
   * @param content SRT 原文。
   * @returns WebVTT 文本。
   */
  srtToVtt(content: string): string {
    // 步骤1：统一换行和时间分隔符，保留字幕块结构。
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const withoutBom = normalized.replace(/^\uFEFF/, "");
    const converted = withoutBom.replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}),(\d{3})/g,
      "$1.$2 --> $3.$4"
    );

    // 步骤2：WebVTT 需要显式头部，浏览器才能作为 text track 解析。
    return `WEBVTT\n\n${converted.trim()}\n`;
  }
}
