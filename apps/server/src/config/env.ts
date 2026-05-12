import type { IceServerConfig } from "@sync-seat/shared";

/**
 * 读取并规范化服务配置。
 *
 * @author 清羽
 */
export class EnvConfig {
  readonly alistBaseUrl = trimTrailingSlash(process.env.ALIST_BASE_URL ?? "");
  readonly alistToken = process.env.ALIST_TOKEN ?? "";
  readonly allowedRootPaths = parseCsv(process.env.ALLOWED_ROOT_PATHS).map(normalizePath);
  readonly stunUrls = parseCsv(process.env.WEBRTC_STUN_URLS || "stun:stun.l.google.com:19302");
  readonly turnUrls = parseCsv(process.env.WEBRTC_TURN_URLS);
  readonly turnUsername = process.env.WEBRTC_TURN_USERNAME;
  readonly turnPassword = process.env.WEBRTC_TURN_PASSWORD;

  /**
   * 生成浏览器 RTCPeerConnection 可直接使用的 ICE 配置。
   */
  getIceServers(): IceServerConfig[] {
    const servers: IceServerConfig[] = this.stunUrls.map((urls) => ({ urls }));
    if (this.turnUrls.length > 0) {
      servers.push({
        urls: this.turnUrls,
        username: this.turnUsername,
        credential: this.turnPassword
      });
    }
    return servers;
  }
}

export function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizePath(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (!clean || clean === ".") {
    return "/";
  }
  return clean.startsWith("/") ? clean.replace(/\/$/, "") || "/" : `/${clean.replace(/\/$/, "")}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
