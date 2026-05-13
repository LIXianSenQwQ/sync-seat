import { BadGatewayException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { CurrentVideo, DriveEntry } from "@sync-seat/shared";
import { EnvConfig, normalizePath } from "../config/env.js";
import { isSubtitleFile, isVideoFile } from "./file-kind.js";

interface AlistItem {
  name: string;
  is_dir: boolean;
  size?: number;
  modified?: string;
  raw_url?: string;
  type?: number;
}

interface AlistResponse<T> {
  code: number;
  message: string;
  data: T;
}

interface AlistAuthData {
  token?: string;
}

/**
 * AList/OpenList 访问客户端。
 *
 * @author 清羽
 */
@Injectable()
export class AlistService {
  private cachedToken: string | null = null;
  private loginPromise: Promise<string> | null = null;

  constructor(private readonly env: EnvConfig = new EnvConfig()) {}

  /**
   * 浏览白名单目录下的文件和目录。
   *
   * @param path 待浏览的网盘路径。
   * @returns 前端可展示的目录条目。
   * @throws ForbiddenException 路径不在白名单内。
   */
  async listDirectory(path: string): Promise<DriveEntry[]> {
    const safePath = normalizePath(path);
    const virtualEntries = this.listVirtualAllowedRoots(safePath);
    if (virtualEntries) {
      return virtualEntries;
    }
    this.assertAllowedPath(safePath);
    const data = await this.request<{ content: AlistItem[] }>("/api/fs/list", {
      path: safePath,
      password: "",
      page: 1,
      per_page: 0,
      refresh: false
    });

    // 步骤1：把 AList 原始条目转换成前端稳定的文件类型。
    return (data.content ?? []).map((item) => {
      const childPath = normalizePath(`${safePath}/${item.name}`);
      const type: DriveEntry["type"] = item.is_dir
        ? "directory"
        : isVideoFile(item.name)
          ? "video"
          : isSubtitleFile(item.name)
            ? "subtitle"
            : "file";
      return {
        name: item.name,
        path: childPath,
        type,
        size: item.size,
        modifiedAt: item.modified
      };
    });
  }

  /**
   * 获取视频可播放直链。
   *
   * @param path 视频文件路径。
   * @returns 当前视频信息。
   * @throws ForbiddenException 路径不在白名单或不是支持的视频。
   */
  async getVideo(path: string): Promise<CurrentVideo> {
    const safePath = this.assertAllowedPath(path);
    if (!isVideoFile(safePath)) {
      throw new ForbiddenException("该文件不是 v1 支持的视频格式");
    }

    const data = await this.request<AlistItem>("/api/fs/get", { path: safePath, password: "" });
    const fileName = safePath.split("/").pop() ?? safePath;
    return {
      filePath: safePath,
      fileName,
      playUrl: data.raw_url ?? `${this.env.alistBaseUrl}/d${encodeURI(safePath)}`,
      size: data.size
    };
  }

  /**
   * 解析文件真实访问地址，供后端 302 跳转或服务端读取使用。
   *
   * @param path 文件路径。
   * @returns AList/OpenList 返回的真实文件地址。
   */
  async resolveFileUrl(path: string): Promise<string> {
    const safePath = this.assertAllowedPath(path);
    const file = await this.request<AlistItem>("/api/fs/get", { path: safePath, password: "" });
    return file.raw_url ?? `${this.env.alistBaseUrl}/d${encodeURI(safePath)}`;
  }

  /**
   * 读取字幕文件文本。
   *
   * @param path 字幕文件路径。
   * @returns 字幕文本内容。
   */
  async readTextFile(path: string): Promise<string> {
    const safePath = this.assertAllowedPath(path);
    if (!isSubtitleFile(safePath)) {
      throw new ForbiddenException("该文件不是 v1 支持的字幕格式");
    }
    const url = await this.resolveFileUrl(safePath);
    const response = await fetch(url, {
      headers: await this.authHeaders()
    });
    if (!response.ok) {
      throw new BadGatewayException("字幕文件读取失败");
    }
    return response.text();
  }

  /**
   * 获取同目录字幕列表。
   *
   * @param videoPath 当前视频路径。
   * @returns 同目录下的字幕文件。
   */
  async listSubtitlesNearVideo(videoPath: string): Promise<DriveEntry[]> {
    const safePath = this.assertAllowedPath(videoPath);
    const directory = safePath.slice(0, safePath.lastIndexOf("/")) || "/";
    return (await this.listDirectory(directory)).filter((entry) => entry.type === "subtitle");
  }

  assertAllowedPath(path: string): string {
    const safePath = normalizePath(path);
    const roots = this.env.allowedRootPaths;
    if (roots.length === 0) {
      throw new ForbiddenException("未配置允许访问的网盘根目录");
    }
    const allowed = roots.some((root) => safePath === root || safePath.startsWith(`${root}/`));
    if (!allowed) {
      throw new ForbiddenException("路径不在允许访问的网盘目录内");
    }
    return safePath;
  }

  private listVirtualAllowedRoots(path: string): DriveEntry[] | null {
    const roots = this.env.allowedRootPaths;
    if (roots.includes("/") || this.isAllowedPath(path)) {
      return null;
    }

    const children = new Map<string, DriveEntry>();
    for (const root of roots) {
      if (!this.isRootParent(path, root)) {
        continue;
      }
      const relative = root.slice(path === "/" ? 1 : path.length + 1);
      const nextSegment = relative.split("/").filter(Boolean)[0];
      if (!nextSegment) {
        continue;
      }
      const childPath = normalizePath(`${path}/${nextSegment}`);
      children.set(childPath, {
        name: nextSegment,
        path: childPath,
        type: "directory"
      });
    }

    return children.size > 0 ? [...children.values()] : null;
  }

  private isAllowedPath(path: string): boolean {
    return this.env.allowedRootPaths.some((root) => path === root || path.startsWith(`${root}/`));
  }

  private isRootParent(path: string, root: string): boolean {
    if (path === "/") {
      return root !== "/";
    }
    return root.startsWith(`${path}/`);
  }

  private async request<T>(apiPath: string, body: unknown): Promise<T> {
    if (!this.env.alistBaseUrl || !this.env.alistUsername || !this.env.alistPassword) {
      throw new BadGatewayException("AList/OpenList 配置不完整");
    }

    return this.requestWithRetry<T>(apiPath, body, true);
  }

  private async requestWithRetry<T>(apiPath: string, body: unknown, allowRelogin: boolean): Promise<T> {
    const response = await fetch(`${this.env.alistBaseUrl}${apiPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders())
      },
      body: JSON.stringify(body)
    });

    if (response.status === 401 || response.status === 403) {
      if (allowRelogin) {
        this.cachedToken = null;
        return this.requestWithRetry<T>(apiPath, body, false);
      }
      throw new UnauthorizedException("AList/OpenList 登录状态无效或无权限");
    }
    if (!response.ok) {
      throw new BadGatewayException("AList/OpenList 服务不可用");
    }

    const payload = (await response.json()) as AlistResponse<T>;
    if (payload.code === 401 || payload.code === 403) {
      if (allowRelogin) {
        this.cachedToken = null;
        return this.requestWithRetry<T>(apiPath, body, false);
      }
      throw new UnauthorizedException(payload.message || "AList/OpenList 鉴权失败");
    }
    if (payload.code !== 200) {
      throw new BadGatewayException(payload.message || "AList/OpenList 请求失败");
    }
    return payload.data;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: await this.getToken()
    };
  }

  private async getToken(): Promise<string> {
    if (this.cachedToken) {
      return this.cachedToken;
    }
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    this.cachedToken = await this.loginPromise;
    return this.cachedToken;
  }

  private async login(): Promise<string> {
    if (!this.env.alistBaseUrl || !this.env.alistUsername || !this.env.alistPassword) {
      throw new BadGatewayException("AList/OpenList 配置不完整");
    }

    const response = await fetch(`${this.env.alistBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: this.env.alistUsername,
        password: this.env.alistPassword
      })
    });

    if (response.status === 401 || response.status === 403) {
      throw new UnauthorizedException("AList/OpenList 用户名或密码错误");
    }
    if (!response.ok) {
      throw new BadGatewayException("AList/OpenList 登录服务不可用");
    }

    const payload = (await response.json()) as AlistResponse<AlistAuthData>;
    if (payload.code === 401 || payload.code === 403) {
      throw new UnauthorizedException(payload.message || "AList/OpenList 用户名或密码错误");
    }
    if (payload.code !== 200 || !payload.data?.token) {
      throw new BadGatewayException(payload.message || "AList/OpenList 登录失败");
    }
    return payload.data.token;
  }
}
