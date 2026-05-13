import { BadGatewayException, ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { EnvConfig } from "../config/env.js";
import { AlistService } from "./alist.service.js";
import { isVideoFile } from "./file-kind.js";

class TestEnv extends EnvConfig {
  override readonly alistBaseUrl: string = "https://alist.test";
  override readonly alistUsername: string = "admin";
  override readonly alistPassword: string = "password";
  override readonly allowedRootPaths = ["/Movies"];
}

describe("AlistService", () => {
  it("只允许访问白名单目录", () => {
    const service = new AlistService(new TestEnv());

    expect(service.assertAllowedPath("/Movies/demo.mp4")).toBe("/Movies/demo.mp4");
    expect(() => service.assertAllowedPath("/Private/demo.mp4")).toThrow(ForbiddenException);
  });

  it("未配置白名单时允许浏览 OpenList 根目录", async () => {
    class OpenRootEnv extends TestEnv {
      override readonly allowedRootPaths = [];
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(alistResponse({ token: "token-1" }))
      .mockResolvedValueOnce(alistResponse({ content: [{ name: "Movies", is_dir: true }] }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new AlistService(new OpenRootEnv());
    const entries = await service.listDirectory("/");

    expect(entries).toEqual([
      {
        name: "Movies",
        path: "/Movies",
        type: "directory",
        size: undefined,
        modifiedAt: undefined
      }
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://alist.test/api/fs/list", expect.objectContaining({
      body: JSON.stringify({ path: "/", password: "", page: 1, per_page: 0, refresh: false })
    }));
    vi.unstubAllGlobals();
  });

  it("根目录返回白名单虚拟目录，避免直接访问 OpenList 根目录被白名单拦截", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = new AlistService(new TestEnv());

    await expect(service.listDirectory("/")).resolves.toEqual([
      {
        name: "Movies",
        path: "/Movies",
        type: "directory"
      }
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("白名单根目录的父目录返回下一层虚拟目录", async () => {
    class NestedRootEnv extends TestEnv {
      override readonly allowedRootPaths = ["/Media/Movies"];
    }
    const service = new AlistService(new NestedRootEnv());

    await expect(service.listDirectory("/Media")).resolves.toEqual([
      {
        name: "Movies",
        path: "/Media/Movies",
        type: "directory"
      }
    ]);
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(alistResponse({ token: "token-1" }))
      .mockResolvedValueOnce(alistResponse({
        content: [
          { name: "Season", is_dir: true },
          { name: "demo.mp4", is_dir: false, size: 12 },
          { name: "demo.srt", is_dir: false, size: 3 },
          { name: "note.txt", is_dir: false }
        ]
      }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new AlistService(new TestEnv());
    const entries = await service.listDirectory("/Movies");

    expect(entries.map((entry) => entry.type)).toEqual(["directory", "video", "subtitle", "file"]);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://alist.test/api/auth/login", expect.objectContaining({
      body: JSON.stringify({ username: "admin", password: "password" })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://alist.test/api/fs/list", expect.objectContaining({
      body: JSON.stringify({ path: "/Movies", password: "", page: 1, per_page: 0, refresh: false }),
      headers: expect.objectContaining({ Authorization: "token-1" })
    }));
    vi.unstubAllGlobals();
  });

  it("缓存用户名密码登录换取的 token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(alistResponse({ token: "token-1" }))
      .mockResolvedValue(alistResponse({ content: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new AlistService(new TestEnv());
    await service.listDirectory("/Movies");
    await service.listDirectory("/Movies");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => url === "https://alist.test/api/auth/login")).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("AList 鉴权失败时清空 token 并重新登录重试一次", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(alistResponse({ token: "token-1" }))
      .mockResolvedValueOnce(alistResponse(null, 401, "token expired"))
      .mockResolvedValueOnce(alistResponse({ token: "token-2" }))
      .mockResolvedValueOnce(alistResponse({ content: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new AlistService(new TestEnv());
    const entries = await service.listDirectory("/Movies");

    expect(entries).toEqual([]);
    expect(fetchMock.mock.calls.filter(([url]) => url === "https://alist.test/api/auth/login")).toHaveLength(2);
    expect(fetchMock).toHaveBeenLastCalledWith("https://alist.test/api/fs/list", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "token-2" })
    }));
    vi.unstubAllGlobals();
  });

  it("缺少用户名密码时报告配置不完整", async () => {
    class MissingCredentialsEnv extends TestEnv {
      override readonly alistUsername = "";
    }
    const service = new AlistService(new MissingCredentialsEnv());

    await expect(service.listDirectory("/Movies")).rejects.toThrow(BadGatewayException);
  });

  it("解析文件真实地址时仍执行白名单校验", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(alistResponse({ token: "token-1" }))
      .mockResolvedValueOnce(alistResponse({ name: "demo.mp4", is_dir: false, raw_url: "https://cdn.test/demo.mp4" }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new AlistService(new TestEnv());

    await expect(service.resolveFileUrl("/Private/demo.mp4")).rejects.toThrow(ForbiddenException);
    await expect(service.resolveFileUrl("/Movies/demo.mp4")).resolves.toBe("https://cdn.test/demo.mp4");
    vi.unstubAllGlobals();
  });
});

function alistResponse<T>(data: T, code = 200, message = "success"): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      code,
      message,
      data
    })
  };
}
