import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvConfig } from "./env.js";

const originalEnv = { ...process.env };

/**
 * 环境配置测试。
 *
 * @author 清羽
 */
describe("EnvConfig 日志配置", () => {
  afterEach(() => {
    // 步骤1：每个用例后恢复环境变量，避免测试之间互相污染。
    process.env = { ...originalEnv };
  });

  it("提供文件日志默认配置", () => {
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_DIR;
    delete process.env.LOG_RETENTION_DAYS;
    delete process.env.LOG_MAX_FILE_SIZE;

    const config = new EnvConfig();

    expect(config.logLevel).toBe("info");
    expect(config.logDir).toBe("logs");
    expect(config.logRetentionDays).toBe("14d");
    expect(config.logMaxFileSize).toBe("20m");
  });

  it("允许通过环境变量覆盖文件日志配置", () => {
    process.env.LOG_LEVEL = "debug";
    process.env.LOG_DIR = "custom-logs";
    process.env.LOG_RETENTION_DAYS = "30d";
    process.env.LOG_MAX_FILE_SIZE = "50m";

    const config = new EnvConfig();

    expect(config.logLevel).toBe("debug");
    expect(config.logDir).toBe("custom-logs");
    expect(config.logRetentionDays).toBe("30d");
    expect(config.logMaxFileSize).toBe("50m");
  });
});

describe("EnvConfig WebRTC ICE 配置", () => {
  afterEach(() => {
    // 步骤1：每个用例后恢复环境变量和系统时间，避免测试之间互相污染。
    process.env = { ...originalEnv };
    vi.useRealTimers();
  });

  it("房主推流 ICE 返回 STUN 和临时 TURN 凭据", () => {
    vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));
    process.env.WEBRTC_STUN_URLS = "stun:stun.test:19302";
    process.env.WEBRTC_TURN_URLS = "turn:turn.test:3478?transport=udp,turn:turn.test:3478?transport=tcp";
    process.env.WEBRTC_TURN_USERNAME = "sync-seat";
    process.env.TURN_AUTH_SECRET = "shared-secret";
    process.env.TURN_CREDENTIAL_TTL_SECONDS = "3600";

    const servers = new EnvConfig().getIceServers();
    const expiresAt = Math.floor(new Date("2026-05-14T00:00:00.000Z").getTime() / 1000) + 3600;
    const username = `${expiresAt}:sync-seat`;
    const credential = createHmac("sha1", "shared-secret").update(username).digest("base64");

    expect(servers).toEqual([
      { urls: "stun:stun.test:19302" },
      {
        urls: ["turn:turn.test:3478?transport=udp", "turn:turn.test:3478?transport=tcp"],
        username,
        credential
      }
    ]);
  });

  it("语音 ICE 只返回临时 TURN，不返回 STUN", () => {
    vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));
    process.env.WEBRTC_STUN_URLS = "stun:stun.test:19302";
    process.env.WEBRTC_TURN_URLS = "turn:turn.test:3478?transport=udp";
    process.env.WEBRTC_TURN_USERNAME = "sync-seat";
    process.env.TURN_AUTH_SECRET = "shared-secret";

    const servers = new EnvConfig().getVoiceIceServers();

    expect(servers).toHaveLength(1);
    expect(String(servers[0].urls)).toContain("turn:");
    expect(String(servers[0].urls)).not.toContain("stun:");
    expect(servers[0].username).toMatch(/^\d+:sync-seat$/);
    expect(servers[0].credential).toBeTruthy();
  });

  it("未配置 TURN_AUTH_SECRET 时不返回 TURN 凭据", () => {
    process.env.WEBRTC_TURN_URLS = "turn:turn.test:3478?transport=udp";
    process.env.WEBRTC_TURN_USERNAME = "sync-seat";
    delete process.env.TURN_AUTH_SECRET;

    const config = new EnvConfig();

    expect(config.getVoiceIceServers()).toEqual([]);
    expect(config.getIceServers().some((server) => String(server.urls).startsWith("turn:"))).toBe(false);
  });
});
