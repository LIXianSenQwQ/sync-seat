import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
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
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true
    })
  ],
  controllers: [AlistController, RoomController],
  providers: [EnvConfig, AlistService, SubtitleService, RoomService, RoomGateway, RealtimeService]
})
export class AppModule {}
