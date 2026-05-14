import type { RoomMember } from "@sync-seat/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVoiceTurnIceServers, VoiceMesh } from "./voice";

class FakeRTCPeerConnection {
  static configs: RTCConfiguration[] = [];
  iceConnectionState: RTCIceConnectionState = "new";
  remoteDescription: RTCSessionDescription | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  constructor(config?: RTCConfiguration) {
    FakeRTCPeerConnection.configs.push(config ?? {});
  }

  addTrack(): RTCRtpSender {
    return {} as RTCRtpSender;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer" };
  }

  async setLocalDescription(): Promise<void> {
    // 测试只关心创建连接时的 ICE 策略。
  }

  close(): void {
    // 测试桩无需释放浏览器资源。
  }
}

const remoteMember: RoomMember = {
  memberId: "remote-member",
  nickname: "远端成员",
  joinedAt: "2026-05-14T00:00:00.000Z",
  connected: true,
  voiceJoined: true,
  muted: false
};

describe("VoiceMesh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeRTCPeerConnection.configs = [];
  });

  it("语音只保留 TURN/TURNS ICE 配置", () => {
    const servers = resolveVoiceTurnIceServers([
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: ["stun:stun.l.google.com:19302", "turn:turn.example.cn:3478?transport=udp", "turns:turn.example.cn:5349"],
        username: "sync-seat",
        credential: "secret"
      }
    ]);

    expect(servers).toEqual([
      {
        urls: ["turn:turn.example.cn:3478?transport=udp", "turns:turn.example.cn:5349"],
        username: "sync-seat",
        credential: "secret"
      }
    ]);
  });

  it("无 TURN 配置时拒绝加入语音", () => {
    expect(() => new VoiceMesh([{ urls: "stun:stun.l.google.com:19302" }], "local-member", vi.fn())).toThrow("强制 TURN 中继");
  });

  it("占位 TURN 或缺少凭据时视为不可用", () => {
    expect(resolveVoiceTurnIceServers([
      { urls: "turn:sync-seat.example.com:3478?transport=udp", username: "sync-seat", credential: "secret" },
      { urls: "turn:turn.example.cn:3478?transport=udp", username: "sync-seat", credential: "replace-with-strong-turn-password" },
      { urls: "turn:turn.example.cn:3478?transport=tcp" }
    ])).toEqual([]);
  });

  it("创建语音 PeerConnection 时强制使用 relay 策略", async () => {
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    const localStream = {
      getTracks: () => [{ kind: "audio" }]
    } as unknown as MediaStream;
    const mesh = new VoiceMesh(
      [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "turn:turn.example.cn:3478?transport=tcp", username: "sync-seat", credential: "secret" }
      ],
      "local-member",
      vi.fn()
    );

    await mesh.join([remoteMember], localStream);

    expect(FakeRTCPeerConnection.configs[0]).toMatchObject({
      iceTransportPolicy: "relay",
      iceServers: [{ urls: "turn:turn.example.cn:3478?transport=tcp", username: "sync-seat", credential: "secret" }]
    });
  });
});
