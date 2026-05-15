import type { RoomMember } from "@sync-seat/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVoiceTurnIceServers, VoiceMesh } from "./voice";

class FakeRTCPeerConnection {
  static configs: RTCConfiguration[] = [];
  static instances: FakeRTCPeerConnection[] = [];
  iceConnectionState: RTCIceConnectionState = "new";
  remoteDescription: RTCSessionDescription | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  constructor(config?: RTCConfiguration) {
    FakeRTCPeerConnection.configs.push(config ?? {});
    FakeRTCPeerConnection.instances.push(this);
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

class FakeAudioContext {
  static contexts: FakeAudioContext[] = [];
  state: AudioContextState = "suspended";
  destination = {};
  sources: Array<{ stream: MediaStream; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  gains: Array<{ gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  destinations: Array<{ stream: MediaStream; disconnect: ReturnType<typeof vi.fn> }> = [];
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });

  constructor() {
    FakeAudioContext.contexts.push(this);
  }

  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode {
    const source = { stream, connect: vi.fn(), disconnect: vi.fn() };
    this.sources.push(source);
    return source as unknown as MediaStreamAudioSourceNode;
  }

  createGain(): GainNode {
    const gain = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }

  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    const destination = { stream: new MediaStream(), disconnect: vi.fn() };
    this.destinations.push(destination);
    return destination as unknown as MediaStreamAudioDestinationNode;
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
    document.body.innerHTML = "";
    FakeRTCPeerConnection.configs = [];
    FakeRTCPeerConnection.instances = [];
    FakeAudioContext.contexts = [];
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

  it("缺少临时凭据时视为不可用", () => {
    expect(resolveVoiceTurnIceServers([
      { urls: "turn:turn.example.cn:3478?transport=udp", username: "", credential: "secret" },
      { urls: "turn:turn.example.cn:3478?transport=tcp", username: "123:sync-seat", credential: "" }
    ])).toEqual([]);
  });

  it("创建语音 PeerConnection 时强制使用 relay 策略", async () => {
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    vi.stubGlobal("AudioContext", FakeAudioContext);
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

  it("加入语音时提前恢复 AudioContext，避免直链模式远端音轨异步到达后被浏览器挂起", async () => {
    await createJoinedVoiceMesh();

    expect(FakeAudioContext.contexts[0].resume).toHaveBeenCalledTimes(1);
  });

  it("拉满语音总音量时远端语音使用 200% 增益", async () => {
    const mesh = await createJoinedVoiceMesh();

    emitRemoteTrack();
    mesh.setVolume(1);

    expect(FakeAudioContext.contexts[0].gains[0].gain.value).toBe(2);
  });

  it("半格语音总音量时远端语音使用原生 100% 增益", async () => {
    const mesh = await createJoinedVoiceMesh();

    emitRemoteTrack();
    mesh.setVolume(0.5);

    expect(FakeAudioContext.contexts[0].gains[0].gain.value).toBe(1);
  });

  it("远端音轨到达时按当前语音总音量初始化增益", async () => {
    const mesh = await createJoinedVoiceMesh();
    mesh.setVolume(0.5);

    emitRemoteTrack();

    expect(FakeAudioContext.contexts[0].gains[0].gain.value).toBe(1);
  });

  it("离开语音时清理远端语音播放链路", async () => {
    const mesh = await createJoinedVoiceMesh();
    emitRemoteTrack();
    const context = FakeAudioContext.contexts[0];

    mesh.leave();

    expect(context.sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(context.gains[0].disconnect).toHaveBeenCalledTimes(1);
    expect(context.destinations[0].disconnect).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("audio")).toHaveLength(0);
  });
});

async function createJoinedVoiceMesh(): Promise<VoiceMesh> {
  vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  const localStream = {
    getTracks: () => [{ kind: "audio", stop: vi.fn() }],
    getAudioTracks: () => [{ enabled: true }]
  } as unknown as MediaStream;
  const mesh = new VoiceMesh(
    [{ urls: "turn:turn.example.cn:3478?transport=tcp", username: "sync-seat", credential: "secret" }],
    "local-member",
    vi.fn()
  );

  await mesh.join([remoteMember], localStream);
  return mesh;
}

function emitRemoteTrack(): void {
  const remoteStream = new MediaStream();
  FakeRTCPeerConnection.instances[0].ontrack?.({ streams: [remoteStream] } as unknown as RTCTrackEvent);
}
