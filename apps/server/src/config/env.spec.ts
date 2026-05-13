import { afterEach, describe, expect, it } from "vitest";
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
