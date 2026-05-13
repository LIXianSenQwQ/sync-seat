import type { ArgumentsHost } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppExceptionFilter } from "./app-exception.filter.js";
import { logError } from "./app-logger.js";

vi.mock("./app-logger.js", () => ({
  logError: vi.fn()
}));

/**
 * 全局异常过滤器测试。
 *
 * @author 清羽
 */
describe("AppExceptionFilter", () => {
  beforeEach(() => {
    vi.mocked(logError).mockClear();
  });

  it("记录 HttpException 并保留响应状态", () => {
    const response = createResponse();
    const filter = new AppExceptionFilter();

    filter.catch(new BadRequestException("参数错误"), createHost(response));

    expect(logError).toHaveBeenCalledWith(
      "AppExceptionFilter",
      "请求处理异常",
      expect.objectContaining({
        method: "GET",
        path: "/api/test",
        statusCode: 400
      })
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it("未知异常按 500 响应", () => {
    const response = createResponse();
    const filter = new AppExceptionFilter();

    filter.catch(new Error("boom"), createHost(response));

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      message: "Internal server error"
    });
  });

  it("非 HTTP 上下文只记录日志", () => {
    const filter = new AppExceptionFilter();

    filter.catch(new Error("ws boom"), { getType: () => "ws" } as unknown as ArgumentsHost);

    expect(logError).toHaveBeenCalledWith(
      "AppExceptionFilter",
      "非 HTTP 上下文异常",
      expect.objectContaining({
        contextType: "ws"
      })
    );
  });
});

/**
 * 构造最小 Express Response mock。
 *
 * @returns 包含 status/json 的响应 mock。
 */
function createResponse(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const response = {
    status: vi.fn(),
    json: vi.fn()
  };
  response.status.mockReturnValue(response);
  return response;
}

/**
 * 构造最小 ArgumentsHost mock。
 *
 * @param response 响应 mock。
 * @returns 可供过滤器读取 request/response 的 host。
 */
function createHost(response: ReturnType<typeof createResponse>): ArgumentsHost {
  return {
    getType: () => "http",
    switchToHttp: () => ({
      getRequest: () => ({
        method: "GET",
        originalUrl: "/api/test",
        url: "/api/test"
      }),
      getResponse: () => response,
      getNext: vi.fn()
    })
  } as unknown as ArgumentsHost;
}
