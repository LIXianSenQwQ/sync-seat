import type { RoomMember } from "@sync-seat/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVoiceTurnIceServers, unlockVoiceAudioPlayback, VoiceMesh } from "./voice";

class FakeRTCPeerConnection {
  static configs: RTCConfiguration[] = [];
  static instances: FakeRTCPeerConnection[] = [];
  iceConnectionState: RTCIceConnectionState = "new";
  localDescription: RTCSessionDescription | null = null;
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

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "answer" };
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
  }

  async addIceCandidate(): Promise<void> {
    // 测试桩无需解析候选。
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
    FakeAudioContext.contexts.forEach((context) => {
      context.state = "closed";
    });
    vi.restoreAllMocks();
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

  it("用户点击加入语音时可以同步解锁后续复用的 AudioContext", async () => {
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    unlockVoiceAudioPlayback();
    await createJoinedVoiceMesh();

    expect(FakeAudioContext.contexts).toHaveLength(1);
    expect(FakeAudioContext.contexts[0].resume).toHaveBeenCalledTimes(1);
  });

  it("增强路径直接输出到 AudioContext.destination，不再依赖隐藏 audio.play", async () => {
    const mesh = await createJoinedVoiceMesh();

    emitRemoteTrack();

    expect(FakeAudioContext.contexts[0].gains[0].connect).toHaveBeenCalledWith(FakeAudioContext.contexts[0].destination);
    expect(document.querySelectorAll("audio")).toHaveLength(0);
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
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("audio")).toHaveLength(0);
  });

  it("Web Audio 不可用时回退到原生 audio 播放远端语音", async () => {
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    vi.stubGlobal("AudioContext", undefined);
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const mesh = new VoiceMesh(
      [{ urls: "turn:turn.example.cn:3478?transport=tcp", username: "sync-seat", credential: "secret" }],
      "local-member",
      vi.fn()
    );
    await mesh.join([remoteMember], createLocalStream());

    emitRemoteTrack();

    const audio = document.querySelector("audio")!;
    expect(audio).toBeTruthy();
    expect(audio.volume).toBe(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("房主先加入语音、观众后加入语音时双方都能处理远端音轨", async () => {
    const sentSignals: Array<{ from: string; target: string; type: "offer" | "answer" | "ice_candidate"; payload: unknown }> = [];
    const owner = await createVoiceMesh("owner", [], sentSignals);
    const viewer = await createVoiceMesh("viewer", [{ ...remoteMember, memberId: "owner" }], sentSignals);
    await owner.syncMembers([
      { ...remoteMember, memberId: "owner" },
      { ...remoteMember, memberId: "viewer" }
    ]);
    const offer = sentSignals.find((signal) => signal.from === "owner" && signal.target === "viewer" && signal.type === "offer")!;

    await viewer.handleSignal("owner", "offer", offer.payload);
    const answer = sentSignals.find((signal) => signal.from === "viewer" && signal.target === "owner" && signal.type === "answer")!;
    await owner.handleSignal("viewer", "answer", answer.payload);
    emitRemoteTrackAt(0);
    emitRemoteTrackAt(1);

    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    expect(FakeAudioContext.contexts[0].sources).toHaveLength(2);
  });

  it("双方几乎同时加入语音时按成员 ID 确定一个 offer 发起方并补齐连接", async () => {
    const sentSignals: Array<{ from: string; target: string; type: "offer" | "answer" | "ice_candidate"; payload: unknown }> = [];
    const owner = await createVoiceMesh("owner", [], sentSignals);
    const viewer = await createVoiceMesh("viewer", [], sentSignals);
    const voiceMembers = [
      { ...remoteMember, memberId: "owner" },
      { ...remoteMember, memberId: "viewer" }
    ];

    await owner.syncMembers(voiceMembers);
    await viewer.syncMembers(voiceMembers);
    const offers = sentSignals.filter((signal) => signal.type === "offer");

    expect(offers).toEqual([{ from: "owner", target: "viewer", type: "offer", payload: { type: "offer", sdp: "offer" } }]);
  });

  it("观众先加入语音、房主后加入语音时双方都能处理远端音轨", async () => {
    const sentSignals: Array<{ from: string; target: string; type: "offer" | "answer" | "ice_candidate"; payload: unknown }> = [];
    const viewer = await createVoiceMesh("viewer", [], sentSignals);
    const owner = await createVoiceMesh("owner", [{ ...remoteMember, memberId: "viewer" }], sentSignals);
    const offer = sentSignals.find((signal) => signal.from === "owner" && signal.target === "viewer" && signal.type === "offer")!;

    await viewer.handleSignal("owner", "offer", offer.payload);
    const answer = sentSignals.find((signal) => signal.from === "viewer" && signal.target === "owner" && signal.type === "answer")!;
    await owner.handleSignal("viewer", "answer", answer.payload);
    emitRemoteTrackAt(0);
    emitRemoteTrackAt(1);

    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    expect(FakeAudioContext.contexts[0].sources).toHaveLength(2);
  });
});

async function createJoinedVoiceMesh(): Promise<VoiceMesh> {
  vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  const mesh = new VoiceMesh(
    [{ urls: "turn:turn.example.cn:3478?transport=tcp", username: "sync-seat", credential: "secret" }],
    "local-member",
    vi.fn()
  );

  await mesh.join([remoteMember], createLocalStream());
  return mesh;
}

function emitRemoteTrack(): void {
  emitRemoteTrackAt(0);
}

function emitRemoteTrackAt(index: number): void {
  const remoteStream = new MediaStream();
  FakeRTCPeerConnection.instances[index].ontrack?.({ streams: [remoteStream] } as unknown as RTCTrackEvent);
}

function createLocalStream(): MediaStream {
  return {
    getTracks: () => [{ kind: "audio", stop: vi.fn() }],
    getAudioTracks: () => [{ enabled: true }]
  } as unknown as MediaStream;
}

async function createVoiceMesh(
  memberId: string,
  members: RoomMember[],
  sentSignals: Array<{ from: string; target: string; type: "offer" | "answer" | "ice_candidate"; payload: unknown }>
): Promise<VoiceMesh> {
  vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  const mesh = new VoiceMesh(
    [{ urls: "turn:turn.example.cn:3478?transport=tcp", username: "sync-seat", credential: "secret" }],
    memberId,
    (target, type, payload) => sentSignals.push({ from: memberId, target, type, payload })
  );
  await mesh.join(members, createLocalStream());
  return mesh;
}
