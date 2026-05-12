import { describe, expect, it } from "vitest";
import { SubtitleService } from "./subtitle.service.js";

describe("SubtitleService", () => {
  it("将 SRT 转换为浏览器可识别的 WebVTT", () => {
    const service = new SubtitleService({} as never);
    const result = service.srtToVtt("1\r\n00:00:01,000 --> 00:00:02,500\r\n你好\r\n");

    expect(result).toContain("WEBVTT");
    expect(result).toContain("00:00:01.000 --> 00:00:02.500");
    expect(result).toContain("你好");
  });

  it("构造当前字幕访问地址", () => {
    const service = new SubtitleService({} as never);

    expect(service.buildCurrentSubtitle("/Movies/demo.srt", "ABC123")).toEqual({
      filePath: "/Movies/demo.srt",
      fileName: "demo.srt",
      format: "srt",
      trackUrl: "/api/rooms/ABC123/subtitle.vtt"
    });
  });
});
