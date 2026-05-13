import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EnvConfig } from "./config/env.js";
import { AlistController } from "./drive/alist.controller.js";
import { AlistService } from "./drive/alist.service.js";
import { SubtitleService } from "./drive/subtitle.service.js";
import { RoomController } from "./room/room.controller.js";
import { RoomGateway } from "./room/room.gateway.js";
import { RoomService } from "./room/room.service.js";
import { RealtimeService } from "./room/realtime.service.js";

/**
 * 应用根模块，集中装配 v1 的网盘、房间和实时同步能力。
 *
 * @author 清羽
 */
const repoEnvPath = findRepoEnvPath();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: repoEnvPath ? [repoEnvPath, ".env"] : [".env"]
    })
  ],
  controllers: [AlistController, RoomController],
  providers: [EnvConfig, AlistService, SubtitleService, RoomService, RoomGateway, RealtimeService]
})
export class AppModule {}

function findRepoEnvPath(): string | null {
  let current = process.cwd();
  while (true) {
    const envPath = join(current, ".env");
    if (existsSync(envPath)) {
      return envPath;
    }
    const parent = join(current, "..");
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
