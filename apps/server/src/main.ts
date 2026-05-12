import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

/**
 * 启动后端服务。
 *
 * @author 清羽
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const origin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

  // 步骤1：允许前端开发服务器访问 REST API 和 WebSocket 握手。
  app.enableCors({
    origin,
    credentials: true
  });

  // 步骤2：按环境变量启动端口，保持单机部署简单。
  const port = Number(process.env.SERVER_PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
