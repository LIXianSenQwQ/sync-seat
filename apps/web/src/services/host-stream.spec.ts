import { describe, expect, it } from "vitest";
import { HOST_STREAM_ICE_STAGE_ORDER, resolveHostStreamIceServersForStage } from "./host-stream";

describe("HostStreamMesh ICE stages", () => {
  it("房主推流暂时只走 IPv6 直连，不通后直接 TURN", () => {
    expect(HOST_STREAM_ICE_STAGE_ORDER).toEqual(["ipv6", "relay"]);
  });

  it("房主推流阶段不会选择 STUN 服务器", () => {
    const servers = [
      { urls: "stun:stun.example.cn:19302" },
      {
        urls: ["stun:stun.example.cn:19302", "turn:turn.example.cn:3478?transport=udp", "turns:turn.example.cn:5349"],
        username: "sync-seat",
        credential: "secret"
      }
    ];

    expect(resolveHostStreamIceServersForStage("ipv6", servers)).toEqual([]);
    expect(resolveHostStreamIceServersForStage("relay", servers)).toEqual([
      {
        urls: ["turn:turn.example.cn:3478?transport=udp", "turns:turn.example.cn:5349"],
        username: "sync-seat",
        credential: "secret"
      }
    ]);
    expect(resolveHostStreamIceServersForStage("ipv4", servers)).toEqual([]);
  });
});
