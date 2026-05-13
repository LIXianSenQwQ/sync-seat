import { describe, expect, it, vi } from "vitest";
import { RoomController } from "./room.controller.js";

describe("RoomController", () => {
  it("当前视频端点 302 跳转到真实播放地址", async () => {
    const controller = new RoomController(
      {
        resolveCurrentVideoUrl: vi.fn(async () => "https://alist.test/d/Movies/demo.mp4")
      } as never,
      {} as never
    );
    const response = createResponse();

    await controller.video("1234", response as never);

    expect(response.redirect).toHaveBeenCalledWith(302, "https://alist.test/d/Movies/demo.mp4");
  });

  it("VTT 字幕端点 302 跳转，SRT 字幕端点返回转换后内容", async () => {
    const rooms = {
      getCurrentSubtitle: vi.fn()
        .mockReturnValueOnce({ filePath: "/Movies/demo.vtt", fileName: "demo.vtt", format: "vtt", trackUrl: "/api/rooms/1234/subtitle.vtt" })
        .mockReturnValueOnce({ filePath: "/Movies/demo.srt", fileName: "demo.srt", format: "srt", trackUrl: "/api/rooms/1234/subtitle.vtt" })
    };
    const subtitles = {
      resolveSubtitleUrl: vi.fn(async () => "https://alist.test/d/Movies/demo.vtt"),
      readAsVtt: vi.fn(async () => "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n你好\n")
    };
    const controller = new RoomController(rooms as never, subtitles as never);
    const vttResponse = createResponse();
    const srtResponse = createResponse();

    await controller.subtitle("1234", vttResponse as never);
    await controller.subtitle("1234", srtResponse as never);

    expect(vttResponse.redirect).toHaveBeenCalledWith(302, "https://alist.test/d/Movies/demo.vtt");
    expect(srtResponse.type).toHaveBeenCalledWith("text/vtt; charset=utf-8");
    expect(srtResponse.send).toHaveBeenCalledWith(expect.stringContaining("WEBVTT"));
  });
});

function createResponse() {
  const response = {
    redirect: vi.fn(),
    type: vi.fn(() => response),
    send: vi.fn()
  };
  return response;
}
