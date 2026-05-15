import type { IceServerConfig, RoomMember } from "@sync-seat/shared";

const MAX_REMOTE_VOICE_GAIN = 2;

type RemoteVoiceAudio = {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  destination: MediaStreamAudioDestinationNode;
  element: HTMLAudioElement;
};

/**
 * WebRTC TURN 中继语音管理器。
 *
 * @author 清羽
 */
export class VoiceMesh {
  private localStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private remoteAudio = new Map<string, RemoteVoiceAudio>();
  private volume = 1;
  private readonly turnIceServers: IceServerConfig[];
  /** 缓存在 setRemoteDescription 之前到达的 ICE candidate */
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();

  constructor(
    iceServers: IceServerConfig[],
    private readonly memberId: string,
    private readonly sendSignal: (targetMemberId: string, type: "offer" | "answer" | "ice_candidate", payload: unknown) => void,
    private readonly onConnectionState?: (memberId: string, state: RTCIceConnectionState) => void
  ) {
    this.turnIceServers = resolveVoiceTurnIceServers(iceServers);
    if (this.turnIceServers.length === 0) {
      throw new Error("语音已配置为强制 TURN 中继，但当前没有可用 TURN 服务。请配置真实的 WEBRTC_TURN_URLS、WEBRTC_TURN_USERNAME 和 TURN_AUTH_SECRET。");
    }
  }

  /**
   * 加入房间语音。
   *
   * @param members 当前房间成员列表。
   * @param localStream 已经由页面用户手势获取到的本地麦克风流。
   */
  async join(members: RoomMember[], localStream?: MediaStream): Promise<void> {
    await this.ensureAudioContext();
    this.localStream = localStream ?? await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    for (const member of members) {
      if (member.memberId !== this.memberId && member.voiceJoined) {
        await this.ensurePeer(member.memberId, true);
      }
    }
  }

  leave(): void {
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.peers.forEach((peer) => peer.close());
    this.peers.clear();
    this.pendingCandidates.clear();
    this.cleanupRemoteAudio();
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
  }

  setMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.remoteAudio.forEach((audio) => {
      audio.gain.gain.value = this.resolveRemoteVoiceGain();
    });
  }

  async handleSignal(fromMemberId: string, signalType: "offer" | "answer" | "ice_candidate", payload: unknown): Promise<void> {
    const peer = await this.ensurePeer(fromMemberId, false);
    if (signalType === "offer") {
      await peer.setRemoteDescription(payload as RTCSessionDescriptionInit);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      this.sendSignal(fromMemberId, "answer", answer);
      await this.flushPendingCandidates(fromMemberId, peer);
    }
    if (signalType === "answer") {
      await peer.setRemoteDescription(payload as RTCSessionDescriptionInit);
      await this.flushPendingCandidates(fromMemberId, peer);
    }
    if (signalType === "ice_candidate" && payload) {
      const candidate = payload as RTCIceCandidateInit;
      if (peer.remoteDescription) {
        await peer.addIceCandidate(candidate);
      } else {
        const queue = this.pendingCandidates.get(fromMemberId) ?? [];
        queue.push(candidate);
        this.pendingCandidates.set(fromMemberId, queue);
      }
    }
  }

  private async flushPendingCandidates(memberId: string, peer: RTCPeerConnection): Promise<void> {
    const queue = this.pendingCandidates.get(memberId);
    if (!queue) return;
    this.pendingCandidates.delete(memberId);
    for (const candidate of queue) {
      await peer.addIceCandidate(candidate);
    }
  }

  private async ensurePeer(targetMemberId: string, initiator: boolean): Promise<RTCPeerConnection> {
    const existing = this.peers.get(targetMemberId);
    if (existing) return existing;

    const peer = new RTCPeerConnection({ iceServers: this.turnIceServers, iceTransportPolicy: "relay" });
    this.peers.set(targetMemberId, peer);

    // 步骤1：本地音频轨道加入每条 TURN 中继语音连接。
    this.localStream?.getTracks().forEach((track) => peer.addTrack(track, this.localStream!));

    // 步骤2：远端音轨通过 Web Audio 增益后交给 audio 元素播放，兼顾增益和浏览器播放兼容性。
    peer.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteStream) this.attachRemoteAudio(targetMemberId, remoteStream);
    };

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(targetMemberId, "ice_candidate", event.candidate);
      }
    };

    // 步骤3：监控 ICE 连接状态，便于排查跨网络连通性问题。
    peer.oniceconnectionstatechange = () => {
      console.log(`[VoiceMesh] ICE 连接状态 (${targetMemberId}): ${peer.iceConnectionState}`);
      this.onConnectionState?.(targetMemberId, peer.iceConnectionState);
    };

    if (initiator) {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.sendSignal(targetMemberId, "offer", offer);
    }
    return peer;
  }

  /**
   * 绑定远端语音流到 Web Audio 播放链路。
   *
   * @param targetMemberId 远端成员 ID。
   * @param stream 远端 WebRTC 音频流。
   */
  private attachRemoteAudio(targetMemberId: string, stream: MediaStream): void {
    this.cleanupRemoteAudio(targetMemberId);
    const context = this.ensureAudioContextSync();
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    const element = document.createElement("audio");

    // 步骤1：将 UI 的 0..1 音量映射为 0..2 增益，保留原滑块交互但提供最高 200% 响度。
    gain.gain.value = this.resolveRemoteVoiceGain();

    // 步骤2：Web Audio 只负责放大，最终仍用隐藏 audio 元素承载播放，避免部分浏览器 destination 无声。
    source.connect(gain);
    gain.connect(destination);
    element.autoplay = true;
    element.volume = 1;
    element.srcObject = destination.stream;
    document.body.appendChild(element);
    void context.resume().catch(() => undefined);
    void element.play().catch(() => undefined);
    this.remoteAudio.set(targetMemberId, { context, source, gain, destination, element });
  }

  /**
   * 提前创建并恢复音频上下文。
   *
   * 浏览器通常要求 Web Audio 在用户手势链路中解锁；直链模式没有房主推流的视频播放动作兜底，
   * 因此加入语音时先预热上下文，远端音轨到达后只复用该上下文。
   */
  private async ensureAudioContext(): Promise<AudioContext> {
    const context = this.ensureAudioContextSync();
    if (context.state === "suspended") {
      await context.resume().catch(() => undefined);
    }
    return context;
  }

  /**
   * 获取当前语音播放使用的 AudioContext。
   *
   * @returns 已创建或新建的 AudioContext。
   */
  private ensureAudioContextSync(): AudioContext {
    if (!this.audioContext || this.audioContext.state === "closed") {
      const AudioContextConstructor = resolveAudioContextConstructor();
      this.audioContext = new AudioContextConstructor();
    }
    return this.audioContext;
  }

  /**
   * 清理远端语音播放资源。
   *
   * @param targetMemberId 指定成员 ID；为空时清理全部远端播放链路。
   */
  private cleanupRemoteAudio(targetMemberId?: string): void {
    const entries = targetMemberId
      ? Array.from(this.remoteAudio.entries()).filter(([memberId]) => memberId === targetMemberId)
      : Array.from(this.remoteAudio.entries());

    for (const [memberId, audio] of entries) {
      audio.source.disconnect();
      audio.gain.disconnect();
      audio.destination.disconnect();
      audio.element.pause();
      audio.element.srcObject = null;
      audio.element.remove();
      this.remoteAudio.delete(memberId);
    }
  }

  /**
   * 计算远端语音增益值。
   *
   * @returns 映射后的 Web Audio 增益，最大为 2。
   */
  private resolveRemoteVoiceGain(): number {
    return this.volume * MAX_REMOTE_VOICE_GAIN;
  }
}

/**
 * 语音只允许使用 TURN/TURNS 中继，避免浏览器回落到局域网直连或 STUN 打洞。
 *
 * @param iceServers 后端返回的完整 ICE 配置。
 * @returns 语音可用的 TURN ICE 配置。
 */
export function resolveVoiceTurnIceServers(iceServers: IceServerConfig[]): IceServerConfig[] {
  return iceServers
    .map((server) => {
      const urls = resolveServerUrls(server).filter(isTurnUrl);
      if (urls.length === 0 || !hasTurnCredentials(server)) return null;
      return {
        ...server,
        urls: Array.isArray(server.urls) ? urls : urls[0]
      };
    })
    .filter((server): server is IceServerConfig => Boolean(server));
}

function resolveServerUrls(server: IceServerConfig): string[] {
  return Array.isArray(server.urls) ? server.urls : [server.urls];
}

function isTurnUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized.startsWith("turn:") || normalized.startsWith("turns:");
}

function hasTurnCredentials(server: IceServerConfig): boolean {
  return Boolean(server.username?.trim() && server.credential?.trim());
}

/**
 * 获取浏览器可用的 AudioContext 构造器。
 *
 * @returns 标准或兼容前缀的 AudioContext 构造器。
 */
function resolveAudioContextConstructor(): typeof AudioContext {
  return window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
}
