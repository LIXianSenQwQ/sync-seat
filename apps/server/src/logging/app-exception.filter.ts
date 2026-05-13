import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";
import { logError } from "./app-logger.js";

/**
 * 全局异常过滤器，记录异常上下文并保持 Nest 原有 HTTP 响应语义。
 *
 * @author 清羽
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  /**
   * 捕获未处理异常并写入错误日志。
   *
   * @param exception 当前异常。
   * @param host Nest 参数上下文。
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== "http") {
      logError("AppExceptionFilter", "非 HTTP 上下文异常", {
        contextType: host.getType(),
        exception
      });
      return;
    }

    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const statusCode = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const responseBody = exception instanceof HttpException ? exception.getResponse() : "Internal server error";

    // 步骤1：只记录可排障的请求摘要，避免把请求体、headers 或凭据写入日志。
    logError("AppExceptionFilter", "请求处理异常", {
      method: request.method,
      path: request.originalUrl || request.url,
      statusCode,
      exception,
      response: responseBody
    });

    response.status(statusCode).json(normalizeResponseBody(statusCode, responseBody));
  }
}

/**
 * 规范化异常响应体，兼容 Nest HttpException 的 string/object 两种格式。
 *
 * @param statusCode HTTP 状态码。
 * @param body Nest 异常响应体。
 * @returns 可直接 JSON 输出的响应对象。
 */
function normalizeResponseBody(statusCode: number, body: string | object): object {
  if (typeof body === "string") {
    return {
      statusCode,
      message: body
    };
  }
  return body;
}
