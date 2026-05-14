import { createHmac } from "node:crypto";
import type { IceServerConfig } from "@sync-seat/shared";

/**
 * 读取并规范化服务配置。
 *
 * @author 清羽
 */
export class EnvConfig {
  readonly alistBaseUrl = trimTrailingSlash(process.env.ALIST_BASE_URL ?? "");
  readonly alistUsername = process.env.ALIST_USERNAME ?? "";
  readonly alistPassword = process.env.ALIST_PASSWORD ?? "";
  readonly allowedRootPaths = parseCsv(process.env.ALLOWED_ROOT_PATHS).map(normalizePath);
  readonly stunUrls = parseCsv(process.env.WEBRTC_STUN_URLS || "stun:stun.l.google.com:19302");
  readonly turnUrls = parseCsv(process.env.WEBRTC_TURN_URLS);
  readonly turnUsername = process.env.WEBRTC_TURN_USERNAME;
  readonly turnAuthSecret = process.env.TURN_AUTH_SECRET ?? "";
  readonly turnCredentialTtlSeconds = parsePositiveInteger(process.env.TURN_CREDENTIAL_TTL_SECONDS, 3600);
  readonly logLevel = process.env.LOG_LEVEL ?? "info";
  readonly logDir = process.env.LOG_DIR ?? "logs";
  readonly logRetentionDays = process.env.LOG_RETENTION_DAYS ?? "14d";
  readonly logMaxFileSize = process.env.LOG_MAX_FILE_SIZE ?? "20m";

  /**
   * 生成房主推流可直接使用的 ICE 配置。
   *
   * @returns STUN 配置和临时 TURN 凭据。
   */
  getIceServers(): IceServerConfig[] {
    return [
      ...this.stunUrls.map((urls) => ({ urls })),
      ...this.getTemporaryTurnIceServers()
    ];
  }

  /**
   * 生成语音专用 ICE 配置。
   *
   * @returns 只包含临时 TURN 凭据，不包含 STUN。
   */
  getVoiceIceServers(): IceServerConfig[] {
    return this.getTemporaryTurnIceServers();
  }

  /**
   * 生成 coturn shared secret 模式兼容的临时 TURN 凭据。
   *
   * @returns TURN 配置未完整时返回空数组。
   */
  private getTemporaryTurnIceServers(): IceServerConfig[] {
    if (this.turnUrls.length === 0 || !this.turnUsername?.trim() || !this.turnAuthSecret.trim()) {
      return [];
    }
    const expiresAt = Math.floor(Date.now() / 1000) + this.turnCredentialTtlSeconds;
    const username = `${expiresAt}:${this.turnUsername.trim()}`;
    const credential = createHmac("sha1", this.turnAuthSecret).update(username).digest("base64");
    return [{ urls: this.turnUrls, username, credential }];
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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
