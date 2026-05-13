/**
 * 日志脱敏工具，避免凭据、请求头或错误对象被原样写入文件。
 *
 * @author 清羽
 */
const SENSITIVE_KEYS = new Set(["authorization", "cookie", "password", "token", "accesstoken", "refreshtoken", "credential"]);

/**
 * 对日志元数据进行递归脱敏。
 *
 * @param value 待写入日志的任意值。
 * @returns 已移除敏感字段且适合 JSON 序列化的值。
 */
export function redactLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = redactLogValue(item);
  }
  return output;
}

/**
 * 将异常对象转换为稳定日志结构。
 *
 * @param error 异常对象。
 * @returns 包含异常名称、消息和堆栈的普通对象。
 */
export function serializeError(error: Error): { name: string; message: string; stack?: string } {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
}

/**
 * 判断字段名是否属于敏感信息。
 *
 * @param key 元数据字段名。
 * @returns 敏感字段返回 true。
 */
function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (normalized === "haspassword") {
    return false;
  }
  return SENSITIVE_KEYS.has(normalized) || normalized.endsWith("password") || normalized.endsWith("token") || /authorization|credential|secret/.test(normalized);
}
