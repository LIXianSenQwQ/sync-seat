import "reflect-metadata";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module.js";
import { AppExceptionFilter } from "./logging/app-exception.filter.js";
import { logInfo } from "./logging/app-logger.js";
import { WinstonNestLogger } from "./logging/nest-logger.js";
import { requestLoggingMiddleware } from "./logging/request-logging.middleware.js";

/**
 * 前端构建产物的默认路径，生产镜像会把 Vue dist 复制到这里。
 */
const defaultWebDistPath = join(process.cwd(), "apps/web/dist");

/**
 * 启动后端服务。
 *
 * @author 清羽
 */
async function bootstrap(): Promise<void> {
  const nestLogger = new WinstonNestLogger();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: nestLogger
  });
  app.useLogger(nestLogger);
  // 信任 Vite/Nginx 代理转发的 X-Forwarded-For 头，以便获取客户端真实 IP。
  app.getHttpAdapter().getInstance().set("trust proxy", 1);
  app.use(requestLoggingMiddleware);
  app.useGlobalFilters(new AppExceptionFilter());
  const origin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

  // 步骤1：允许前端开发服务器访问 REST API 和 WebSocket 握手。
  app.enableCors({
    origin,
    credentials: true
  });

  // 步骤2：生产镜像存在前端构建产物时，直接由 Nest 托管静态资源。
  const staticAssetsEnabled = configureStaticAssets(app);

  // 步骤3：按环境变量启动端口，保持单机部署简单。
  const port = Number(process.env.SERVER_PORT ?? 3000);
  await app.listen(port);
  logInfo("Bootstrap", "服务启动完成", {
    port,
    origin,
    staticAssetsEnabled
  });
}

/**
 * 在生产部署中托管 Vue 构建产物，并为 history 路由提供 index.html fallback。
 *
 * @param app Nest Express 应用实例。
 */
function configureStaticAssets(app: NestExpressApplication): boolean {
  const webDistPath = resolve(process.env.WEB_DIST_PATH ?? defaultWebDistPath);
  const indexFilePath = join(webDistPath, "index.html");

  if (!existsSync(indexFilePath)) {
    logInfo("Bootstrap", "未启用前端静态资源托管", { webDistPath });
    return false;
  }

  app.useStaticAssets(webDistPath, {
    index: false
  });

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!shouldServeSpaFallback(request)) {
      next();
      return;
    }

    response.sendFile(indexFilePath);
  });
  logInfo("Bootstrap", "已启用前端静态资源托管", { webDistPath });
  return true;
}

/**
 * 判断当前请求是否应回退到 Vue 单页应用入口。
 *
 * @param request Express 请求对象。
 * @returns 仅页面导航请求返回 true，API、Socket.IO 和静态文件请求返回 false。
 */
function shouldServeSpaFallback(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  if (request.path.startsWith("/api") || request.path.startsWith("/socket.io")) {
    return false;
  }

  if (extname(request.path)) {
    return false;
  }

  const acceptHeader = request.headers.accept;
  if (Array.isArray(acceptHeader)) {
    return acceptHeader.some((value) => value.includes("text/html"));
  }

  return typeof acceptHeader === "string" && acceptHeader.includes("text/html");
}

void bootstrap();
