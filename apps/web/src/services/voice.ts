import type { IceServerConfig, RoomMember } from "@sync-seat/shared";

const MAX_REMOTE_VOICE_GAIN = 2;
let sharedVoiceAudioContext: AudioContext | null = null;

type EnhancedRemoteVoiceAudio = {
  mode: "enhanced";
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
};

type FallbackRemoteVoiceAudio = {
  mode: "fallback";
  element: HTMLAudioElement;
};

type RemoteVoiceAudio = EnhancedRemoteVoiceAudio | FallbackRemoteVoiceAudio;

/**
 * WebRTC TURN 中继语音管理器。
 *
 * @author 清羽
 */
export class VoiceMesh {
  private localStream: MediaStream | null = null;
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
    await this.syncMembers(members);
  }

  /**
   * 按最新房间成员状态补齐语音连接。
   *
   * @param members 当前房间成员列表。
   */
  async syncMembers(members: RoomMember[]): Promise<void> {
    for (const member of members) {
      if (member.memberId !== this.memberId && member.voiceJoined && this.shouldInitiatePeer(member.memberId)) {
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
    void closeSharedVoiceAudioContext();
  }

  setMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.remoteAudio.forEach((audio) => {
      if (audio.mode === "enhanced") {
        audio.gain.gain.value = this.resolveRemoteVoiceGain();
        return;
      }
      audio.element.volume = this.volume;
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

    // 步骤2：远端音轨优先通过已解锁的 Web Audio 增益播放，失败时回退原生 audio。
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
   * 判断当前成员是否负责主动发起指定成员的语音连接。
   *
   * @param targetMemberId 目标成员 ID。
   * @returns 当前成员是否作为 offer 发起方。
   */
  private shouldInitiatePeer(targetMemberId: string): boolean {
    return this.memberId.localeCompare(targetMemberId) < 0;
  }

  /**
   * 绑定远端语音流到 Web Audio 播放链路。
   *
   * @param targetMemberId 远端成员 ID。
   * @param stream 远端 WebRTC 音频流。
   */
  private attachRemoteAudio(targetMemberId: string, stream: MediaStream): void {
    this.cleanupRemoteAudio(targetMemberId);
    const enhanced = this.attachEnhancedRemoteAudio(stream);
    if (enhanced) {
      this.remoteAudio.set(targetMemberId, enhanced);
      return;
    }
    this.remoteAudio.set(targetMemberId, this.attachFallbackRemoteAudio(stream));
  }

  /**
   * 使用 Web Audio 增益播放远端语音。
   *
   * @param stream 远端 WebRTC 音频流。
   * @returns 可清理的增强播放资源；不可用时返回空并交给原生 audio 兜底。
   */
  private attachEnhancedRemoteAudio(stream: MediaStream): EnhancedRemoteVoiceAudio | null {
    try {
      const context = this.ensureAudioContextSync();
      if (!context) {
        console.warn("[VoiceMesh] 当前浏览器不支持 AudioContext，使用原生 audio 兜底");
        return null;
      }
      if (context.state === "suspended") {
        void context.resume().catch((err) => console.warn("[VoiceMesh] 恢复 AudioContext 失败，尝试原生 audio 兜底", err));
      }
      if (context.state !== "running") {
        console.warn(`[VoiceMesh] AudioContext 当前状态为 ${context.state}，使用原生 audio 兜底`);
        return null;
      }
      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();

      // 步骤1：将 UI 的 0..1 音量映射为 0..2 增益，保留原滑块交互但提供最高 200% 响度。
      gain.gain.value = this.resolveRemoteVoiceGain();

      // 步骤2：直接输出到 AudioContext.destination，避免 hidden audio.play 被浏览器拦截。
      source.connect(gain);
      gain.connect(context.destination);
      return { mode: "enhanced", context, source, gain };
    } catch (err) {
      console.warn("[VoiceMesh] Web Audio 增强语音不可用，使用原生 audio 兜底", err);
      return null;
    }
  }

  /**
   * 使用原生 audio 播放远端语音。
   *
   * @param stream 远端 WebRTC 音频流。
   * @returns 可清理的原生播放资源。
   */
  private attachFallbackRemoteAudio(stream: MediaStream): FallbackRemoteVoiceAudio {
    const element = document.createElement("audio");
    element.autoplay = true;
    element.volume = this.volume;
    element.srcObject = stream;
    document.body.appendChild(element);
    void element.play().catch((err) => console.warn("[VoiceMesh] 原生 audio 兜底播放失败", err));
    return { mode: "fallback", element };
  }

  /**
   * 提前创建并恢复音频上下文。
   *
   * 浏览器通常要求 Web Audio 在用户手势链路中解锁；直链模式没有房主推流的视频播放动作兜底，
   * 因此加入语音时先预热上下文，远端音轨到达后只复用该上下文。
   */
  private async ensureAudioContext(): Promise<AudioContext | null> {
    const context = this.ensureAudioContextSync();
    if (context?.state === "suspended") {
      await context.resume().catch(() => undefined);
    }
    return context;
  }

  /**
   * 获取当前语音播放使用的 AudioContext。
   *
   * @returns 已创建或新建的 AudioContext；浏览器不支持时返回空。
   */
  private ensureAudioContextSync(): AudioContext | null {
    return ensureSharedVoiceAudioContext();
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
      if (audio.mode === "enhanced") {
        audio.source.disconnect();
        audio.gain.disconnect();
      } else {
        audio.element.pause();
        audio.element.srcObject = null;
        audio.element.remove();
      }
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
 * 在用户点击“加入语音”的同步调用栈内解锁 Web Audio。
 *
 * 增益链路依赖 AudioContext；如果等 ICE、麦克风授权或远端 ontrack 后再创建，
 * 浏览器可能已失去用户激活上下文，导致直链模式或推流开始前的语音无声。
 */
export function unlockVoiceAudioPlayback(): void {
  const context = ensureSharedVoiceAudioContext();
  if (context?.state === "suspended") {
    void context.resume().catch(() => undefined);
  }
}

/**
 * 释放语音播放的共享 AudioContext。
 */
function closeSharedVoiceAudioContext(): void {
  void sharedVoiceAudioContext?.close().catch(() => undefined);
  sharedVoiceAudioContext = null;
}

/**
 * 获取语音播放共用的 AudioContext。
 *
 * @returns 已创建或新建的 AudioContext；浏览器不支持时返回空。
 */
function ensureSharedVoiceAudioContext(): AudioContext | null {
  if (!sharedVoiceAudioContext || sharedVoiceAudioContext.state === "closed") {
    const AudioContextConstructor = resolveAudioContextConstructor();
    if (!AudioContextConstructor) return null;
    sharedVoiceAudioContext = new AudioContextConstructor();
  }
  return sharedVoiceAudioContext;
}

/**
 * 获取浏览器可用的 AudioContext 构造器。
 *
 * @returns 标准或兼容前缀的 AudioContext 构造器。
 */
function resolveAudioContextConstructor(): typeof AudioContext | null {
  return window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null;
}
