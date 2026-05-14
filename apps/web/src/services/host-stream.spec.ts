import { describe, expect, it, vi } from "vitest";
import { HOST_STREAM_ICE_STAGE_ORDER, HostStreamMesh, resolveHostStreamIceServersForStage } from "./host-stream";

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

  it("按成员切换清晰度时只更新该成员的视频 sender", async () => {
    const firstSender = {
      getParameters: vi.fn(() => ({ encodings: [{}] })),
      setParameters: vi.fn(async (_params: RTCRtpSendParameters) => undefined)
    };
    const secondSender = {
      getParameters: vi.fn(() => ({ encodings: [{}] })),
      setParameters: vi.fn(async (_params: RTCRtpSendParameters) => undefined)
    };
    const mesh = new HostStreamMesh([], "owner", "", vi.fn(), vi.fn());
    const internal = mesh as unknown as {
      videoSendersByMember: Map<string, Set<typeof firstSender>>;
    };
    internal.videoSendersByMember.set("viewer-a", new Set([firstSender]));
    internal.videoSendersByMember.set("viewer-b", new Set([secondSender]));

    await mesh.setMemberQuality("viewer-a", "smooth");

    expect(firstSender.setParameters).toHaveBeenCalledOnce();
    expect(secondSender.setParameters).not.toHaveBeenCalled();
    const sentParameters = firstSender.setParameters.mock.calls[0]?.[0];
    expect(sentParameters?.encodings?.[0]?.maxBitrate).toBe(2_500_000);
  });
});
