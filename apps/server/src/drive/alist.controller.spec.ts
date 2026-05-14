import { describe, expect, it } from "vitest";
import type { IceServerConfig } from "@sync-seat/shared";
import type { AlistService } from "./alist.service.js";
import { AlistController } from "./alist.controller.js";

class TestEnv {
  getIceServers(): IceServerConfig[] {
    return [
      { urls: "stun:stun.test:19302" },
      { urls: "turn:turn.test:3478?transport=udp", username: "123:sync-seat", credential: "signed" }
    ];
  }

  getVoiceIceServers(): IceServerConfig[] {
    return [
      { urls: "turn:turn.test:3478?transport=udp", username: "123:sync-seat", credential: "signed" }
    ];
  }
}

/**
 * 网盘控制器 ICE 配置测试。
 *
 * @author 清羽
 */
describe("AlistController ICE 配置", () => {
  it("视频接口返回 STUN 和临时 TURN", () => {
    const controller = new AlistController({} as AlistService, new TestEnv() as never);

    expect(controller.iceServers()).toEqual([
      { urls: "stun:stun.test:19302" },
      { urls: "turn:turn.test:3478?transport=udp", username: "123:sync-seat", credential: "signed" }
    ]);
  });

  it("语音接口只返回临时 TURN", () => {
    const controller = new AlistController({} as AlistService, new TestEnv() as never);

    expect(controller.voiceIceServers()).toEqual([
      { urls: "turn:turn.test:3478?transport=udp", username: "123:sync-seat", credential: "signed" }
    ]);
  });
});
