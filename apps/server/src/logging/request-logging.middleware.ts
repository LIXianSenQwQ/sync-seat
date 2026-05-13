import type { NextFunction, Request, Response } from "express";
import { logInfo } from "./app-logger.js";

/**
 * HTTP 请求日志中间件，只记录路径、状态和耗时，不记录请求体或敏感头。
 *
 * @author 清羽
 */
export function requestLoggingMiddleware(request: Request, response: Response, next: NextFunction): void {
  const startedAt = performance.now();

  response.on("finish", () => {
    // 步骤1：响应结束后才能拿到最终状态码，便于定位慢请求和错误请求。
    logInfo("HttpRequest", "HTTP 请求完成", {
      method: request.method,
      path: request.originalUrl || request.url,
      statusCode: response.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
      ip: (request.ip ?? request.socket.remoteAddress ?? "unknown").replace(/^::ffff:/i, "")
    });
  });

  next();
}
