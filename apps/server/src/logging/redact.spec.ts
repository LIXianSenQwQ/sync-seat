import { describe, expect, it } from "vitest";
import { redactLogValue, serializeError } from "./redact.js";

/**
 * 日志脱敏工具测试。
 *
 * @author 清羽
 */
describe("redactLogValue", () => {
  it("递归移除凭据类字段", () => {
    const output = redactLogValue({
      username: "admin",
      hasPassword: true,
      password: "secret",
      headers: {
        authorization: "Bearer token",
        cookie: "sid=1"
      },
      nested: [{ accessToken: "abc", filePath: "/Movies/demo.mp4" }]
    });

    expect(output).toEqual({
      username: "admin",
      hasPassword: true,
      password: "[REDACTED]",
      headers: {
        authorization: "[REDACTED]",
        cookie: "[REDACTED]"
      },
      nested: [{ accessToken: "[REDACTED]", filePath: "/Movies/demo.mp4" }]
    });
  });

  it("把 Error 序列化成稳定结构", () => {
    const error = new Error("boom");
    const output = serializeError(error);

    expect(output.name).toBe("Error");
    expect(output.message).toBe("boom");
    expect(output.stack).toContain("boom");
  });
});
