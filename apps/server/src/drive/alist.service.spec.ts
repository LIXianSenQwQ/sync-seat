import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { EnvConfig } from "../config/env.js";
import { AlistService } from "./alist.service.js";
import { isVideoFile } from "./file-kind.js";

class TestEnv extends EnvConfig {
  override readonly alistBaseUrl = "https://alist.test";
  override readonly alistToken = "token";
  override readonly allowedRootPaths = ["/Movies"];
}

describe("AlistService", () => {
  it("只允许访问白名单目录", () => {
    const service = new AlistService(new TestEnv());

    expect(service.assertAllowedPath("/Movies/demo.mp4")).toBe("/Movies/demo.mp4");
    expect(() => service.assertAllowedPath("/Private/demo.mp4")).toThrow(ForbiddenException);
  });

  it("识别 v1 支持的视频后缀", () => {
    expect(isVideoFile("demo.mp4")).toBe(true);
    expect(isVideoFile("demo.webm")).toBe(true);
    expect(isVideoFile("demo.m3u8")).toBe(true);
    expect(isVideoFile("demo.mov")).toBe(true);
    expect(isVideoFile("demo.mkv")).toBe(true);
    expect(isVideoFile("demo.avi")).toBe(true);
    expect(isVideoFile("demo.txt")).toBe(false);
  });

  it("把 AList 目录条目转换成稳定类型", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: 200,
          message: "success",
          data: {
            content: [
              { name: "Season", is_dir: true },
              { name: "demo.mp4", is_dir: false, size: 12 },
              { name: "demo.srt", is_dir: false, size: 3 },
              { name: "note.txt", is_dir: false }
            ]
          }
        })
      }))
    );

    const service = new AlistService(new TestEnv());
    const entries = await service.listDirectory("/Movies");

    expect(entries.map((entry) => entry.type)).toEqual(["directory", "video", "subtitle", "file"]);
    vi.unstubAllGlobals();
  });
});
