import { describe, expect, it, vi } from "vitest";
import { RoomController } from "./room.controller.js";

describe("RoomController", () => {
  it("当前视频端点代理上游视频流并保留 Range 响应头", async () => {
    const controller = new RoomController(
      {
        openCurrentVideoStream: vi.fn(async () => ({
          status: 206,
          headers: new Headers({
            "accept-ranges": "bytes",
            "content-length": "100",
            "content-range": "bytes 0-99/1000",
            "content-type": "video/mp4"
          }),
          body: null
        }))
      } as never,
      {} as never
    );
    const response = createResponse();

    await controller.video("1234", "bytes=0-99", response as never);

    expect(response.status).toHaveBeenCalledWith(206);
    expect(response.setHeader).toHaveBeenCalledWith("content-range", "bytes 0-99/1000");
    expect(response.setHeader).toHaveBeenCalledWith("content-length", "100");
    expect(response.setHeader).toHaveBeenCalledWith("content-type", "video/mp4");
    expect(response.redirect).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalled();
  });

  it("VTT 和 SRT 字幕端点都返回 WebVTT 内容，避免浏览器跳转内网地址", async () => {
    const rooms = {
      getCurrentSubtitle: vi.fn()
        .mockReturnValueOnce({ filePath: "/Movies/demo.vtt", fileName: "demo.vtt", format: "vtt", trackUrl: "/api/rooms/1234/subtitle.vtt" })
        .mockReturnValueOnce({ filePath: "/Movies/demo.srt", fileName: "demo.srt", format: "srt", trackUrl: "/api/rooms/1234/subtitle.vtt" })
    };
    const subtitles = {
      readAsVtt: vi.fn(async () => "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n你好\n")
    };
    const controller = new RoomController(rooms as never, subtitles as never);
    const vttResponse = createResponse();
    const srtResponse = createResponse();

    await controller.subtitle("1234", vttResponse as never);
    await controller.subtitle("1234", srtResponse as never);

    expect(vttResponse.redirect).not.toHaveBeenCalled();
    expect(vttResponse.type).toHaveBeenCalledWith("text/vtt; charset=utf-8");
    expect(vttResponse.send).toHaveBeenCalledWith(expect.stringContaining("WEBVTT"));
    expect(srtResponse.type).toHaveBeenCalledWith("text/vtt; charset=utf-8");
    expect(srtResponse.send).toHaveBeenCalledWith(expect.stringContaining("WEBVTT"));
  });
});

function createResponse() {
  const response = {
    redirect: vi.fn(),
    status: vi.fn(() => response),
    setHeader: vi.fn(),
    type: vi.fn(() => response),
    send: vi.fn(),
    end: vi.fn()
  };
  return response;
}
