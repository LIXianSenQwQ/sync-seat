import type { IceServerConfig, RoomMember } from "@sync-seat/shared";
import {
  canReplaceMdnsCandidate,
  createInitialHostStreamIceDiagnostics,
  parseIceCandidate,
  parseIceCandidateStats,
  replaceMdnsCandidateAddress,
  updateDiagnosticsConnectionState,
  updateDiagnosticsSelectedCandidate,
  updateDiagnosticsWithCandidate,
  type HostStreamIceDiagnostics
} from "./ice-diagnostics";

type HostSignalType = "offer" | "answer" | "ice_candidate";
export type HostStreamQuality = "original" | "standard" | "smooth";

interface QualityProfile {
  label: string;
  maxBitrate: number;
  maxFramerate: number;
  targetHeight: number | null;
  contentHint: string;
  degradationPreference: "maintain-resolution" | "balanced";
}

const QUALITY_PROFILES: Record<HostStreamQuality, QualityProfile> = {
  original: {
    label: "原画",
    maxBitrate: 8_000_000,
    maxFramerate: 30,
    targetHeight: null,
    contentHint: "detail",
    degradationPreference: "maintain-resolution"
  },
  standard: {
    label: "标准",
    maxBitrate: 5_000_000,
    maxFramerate: 30,
    targetHeight: 1080,
    contentHint: "detail",
    degradationPreference: "maintain-resolution"
  },
  smooth: {
    label: "流畅",
    maxBitrate: 2_500_000,
    maxFramerate: 30,
    targetHeight: 720,
    contentHint: "motion",
    degradationPreference: "balanced"
  }
};

type ConfigurableSendParameters = RTCRtpSendParameters & {
  degradationPreference?: "maintain-framerate" | "maintain-resolution" | "balanced";
};

interface CaptureVideo extends HTMLVideoElement {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
}

/**
 * 房主推流模式的 WebRTC 视频流管理器。
 *
 * @author 清羽
 */
export class HostStreamMesh {
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private peerInitiators = new Map<string, boolean>();
  private iceDiagnostics = new Map<string, HostStreamIceDiagnostics>();
  private restartedPeers = new Set<string>();
  private videoSenders = new Set<RTCRtpSender>();
  private sourceVideoHeight = 0;
  private quality: HostStreamQuality = "original";
  /** 缓存在 setRemoteDescription 之前到达的 ICE candidate */
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();

  constructor(
    private readonly iceServers: IceServerConfig[],
    private readonly memberId: string,
    /** 服务端检测到的客户端真实局域网 IP，用于修复 Chrome mDNS 隐藏 */
    private readonly localIp: string,
    private readonly sendSignal: (targetMemberId: string, type: HostSignalType, payload: unknown) => void,
    private readonly onRemoteStream: (stream: MediaStream) => void,
    private readonly onConnectionState?: (memberId: string, state: RTCIceConnectionState) => void,
    private readonly onDiagnostics?: (memberId: string, diagnostics: HostStreamIceDiagnostics) => void,
    initialQuality: HostStreamQuality = "original"
  ) {
    this.quality = initialQuality;
  }

  /**
   * 从房主本地播放器采集媒体流。
   */
  captureFromVideo(video: HTMLVideoElement): MediaStream {
    const source = video as CaptureVideo;
    const stream = source.captureStream?.() ?? source.mozCaptureStream?.();
    if (!stream) {
      throw new Error("当前浏览器不支持从播放器采集推流，请使用 Chrome 或 Edge");
    }
    this.localStream = stream;
    this.sourceVideoHeight = video.videoHeight || 0;
    this.applyTrackContentHint();
    console.log(`[HostStream] 源视频尺寸: ${video.videoWidth || "unknown"}x${video.videoHeight || "unknown"}`);
    return stream;
  }

  /**
   * 切换房主推流清晰度，并立即应用到已经建立的发送端。
   */
  async setQuality(quality: HostStreamQuality): Promise<void> {
    this.quality = quality;
    this.applyTrackContentHint();
    await Promise.all(Array.from(this.videoSenders).map((sender) => this.applySenderQuality(sender)));
  }

  /**
   * 房主为在线观众建立推流连接。
   */
  async publishToMembers(members: RoomMember[]): Promise<void> {
    if (!this.localStream) return;
    const targets = members.filter((m) => m.memberId !== this.memberId && m.connected);
    console.log(`[HostStream] 准备向 ${targets.length} 名在线成员推流`);
    for (const member of targets) {
      await this.ensurePeer(member.memberId, true);
    }
  }

  /**
   * 处理远端 WebRTC 信令。
   */
  async handleSignal(fromMemberId: string, signalType: HostSignalType, payload: unknown): Promise<void> {
    console.log(`[HostStream] 收到信令 (${signalType}) from ${fromMemberId}`);
    const peer = await this.ensurePeer(fromMemberId, false);
    if (signalType === "offer") {
      console.log(`[HostStream] 处理 offer from ${fromMemberId}，设置远端描述并创建应答`);
      await peer.setRemoteDescription(payload as RTCSessionDescriptionInit);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      this.sendSignal(fromMemberId, "answer", answer);
      await this.flushPendingCandidates(fromMemberId, peer);
      console.log(`[HostStream] 应答已发送 to ${fromMemberId}`);
    }
    if (signalType === "answer") {
      console.log(`[HostStream] 处理 answer from ${fromMemberId}，设置远端描述`);
      await peer.setRemoteDescription(payload as RTCSessionDescriptionInit);
      await this.flushPendingCandidates(fromMemberId, peer);
    }
    if (signalType === "ice_candidate" && payload) {
      const candidate = payload as RTCIceCandidateInit;
      this.recordCandidate(fromMemberId, candidate);
      if (peer.remoteDescription) {
        await peer.addIceCandidate(candidate);
      } else {
        console.log(`[HostStream] ICE candidate 提前到达 (${fromMemberId})，加入待处理队列`);
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

  stop(): void {
    this.peers.forEach((peer) => peer.close());
    this.peers.clear();
    this.peerInitiators.clear();
    this.iceDiagnostics.clear();
    this.restartedPeers.clear();
    this.videoSenders.clear();
    this.localStream = null;
    this.remoteStream = null;
    this.sourceVideoHeight = 0;
  }

  private async ensurePeer(targetMemberId: string, initiator: boolean): Promise<RTCPeerConnection> {
    const existing = this.peers.get(targetMemberId);
    if (existing) return existing;

    const peer = new RTCPeerConnection({ iceServers: this.iceServers, iceTransportPolicy: "all" });
    this.peers.set(targetMemberId, peer);
    this.peerInitiators.set(targetMemberId, initiator);
    this.ensureDiagnostics(targetMemberId);
    console.log(`[HostStream] 创建 PeerConnection (${targetMemberId})，initiator=${initiator}`);

    // 步骤1：房主把本地视频轨道推给观众；观众没有本地轨道也能回 answer。
    const tracks = this.localStream?.getTracks() ?? [];
    console.log(`[HostStream] 添加 ${tracks.length} 条轨道到 PeerConnection (${targetMemberId})`);
    for (const track of tracks) {
      const sender = peer.addTrack(track, this.localStream!);
      if (track.kind === "video") {
        this.videoSenders.add(sender);
        await this.applySenderQuality(sender);
      }
    }

    // 步骤2：观众收到房主媒体流后交给页面播放器渲染。
    peer.ontrack = (event) => {
      const [stream] = event.streams;
      console.log(`[HostStream] ontrack 触发 (${targetMemberId})，stream=${stream?.id ?? 'none'}，tracks=${event.track.kind}`);
      if (stream && stream !== this.remoteStream) {
        this.remoteStream = stream;
        this.onRemoteStream(stream);
      }
    };

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        const parsed = this.recordCandidate(targetMemberId, event.candidate);
        // Chrome mDNS 隐藏把局域网 IP 换成 .local 地址
        // address 可能为 null 或直接就是 .local 主机名（取决于 Chrome 版本）
        if (this.localIp && canReplaceMdnsCandidate(event.candidate, this.localIp)) {
          const fixedCandidate = replaceMdnsCandidateAddress(event.candidate, this.localIp);
          this.recordCandidate(targetMemberId, fixedCandidate);
          console.log(`[HostStream] ICE 候选 (${targetMemberId}, host): 修复 mDNS → ${this.localIp}`);
          this.sendSignal(targetMemberId, "ice_candidate", fixedCandidate);
          return;
        }
        if (parsed?.isMdns && this.localIp) {
          console.log(`[HostStream] ICE 候选 (${targetMemberId}, host): 保留 mDNS，whoami 返回的 ${this.localIp} 不是私有 IPv4`);
        }
        console.log(
          `[HostStream] ICE 候选 (${targetMemberId}, ${parsed?.type ?? "unknown"}): ${parsed?.protocol ?? "unknown"} ${parsed?.address ?? "unknown"}:${parsed?.port ?? ""}`
        );
        this.sendSignal(targetMemberId, "ice_candidate", event.candidate);
      }
    };

    // 步骤3：监控 ICE 连接状态，便于排查跨网络连通性问题。
    peer.oniceconnectionstatechange = () => {
      console.log(`[HostStream] ICE 连接状态 (${targetMemberId}): ${peer.iceConnectionState}`);
      this.onConnectionState?.(targetMemberId, peer.iceConnectionState);
      this.updateDiagnostics(targetMemberId, (diagnostics) => updateDiagnosticsConnectionState(diagnostics, peer.iceConnectionState));
      if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
        void this.refreshSelectedCandidate(targetMemberId, peer);
      }
      if (peer.iceConnectionState === "failed") {
        void this.restartIceOnce(targetMemberId, peer);
      }
    };

    if (initiator) {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.sendSignal(targetMemberId, "offer", offer);
    }
    return peer;
  }

  private recordCandidate(memberId: string, candidate: RTCIceCandidateInit | RTCIceCandidate): ReturnType<typeof parseIceCandidate> {
    const parsed = parseIceCandidate(candidate);
    this.updateDiagnostics(memberId, (diagnostics) => updateDiagnosticsWithCandidate(diagnostics, parsed));
    return parsed;
  }

  private ensureDiagnostics(memberId: string): HostStreamIceDiagnostics {
    const existing = this.iceDiagnostics.get(memberId);
    if (existing) return existing;
    const diagnostics = createInitialHostStreamIceDiagnostics();
    this.iceDiagnostics.set(memberId, diagnostics);
    this.onDiagnostics?.(memberId, diagnostics);
    return diagnostics;
  }

  private updateDiagnostics(
    memberId: string,
    updater: (diagnostics: HostStreamIceDiagnostics) => HostStreamIceDiagnostics
  ): HostStreamIceDiagnostics {
    const next = updater(this.ensureDiagnostics(memberId));
    this.iceDiagnostics.set(memberId, next);
    this.onDiagnostics?.(memberId, next);
    return next;
  }

  private async restartIceOnce(memberId: string, peer: RTCPeerConnection): Promise<void> {
    if (!this.peerInitiators.get(memberId) || this.restartedPeers.has(memberId) || peer.signalingState !== "stable") return;
    this.restartedPeers.add(memberId);
    this.updateDiagnostics(memberId, (diagnostics) => updateDiagnosticsConnectionState(diagnostics, peer.iceConnectionState, true));
    try {
      peer.restartIce();
      const offer = await peer.createOffer({ iceRestart: true });
      await peer.setLocalDescription(offer);
      this.sendSignal(memberId, "offer", offer);
      console.warn(`[HostStream] ICE 连接失败，已向 ${memberId} 发起一次 ICE restart`);
    } catch (err) {
      console.warn(`[HostStream] ICE restart 失败 (${memberId}):`, err);
    }
  }

  private async refreshSelectedCandidate(memberId: string, peer: RTCPeerConnection): Promise<void> {
    try {
      const stats = await peer.getStats();
      let selectedPair: Record<string, unknown> | null = null;
      for (const report of stats.values()) {
        const candidatePair = report as unknown as Record<string, unknown>;
        if (
          candidatePair.type === "candidate-pair" &&
          candidatePair.state === "succeeded" &&
          (candidatePair.selected === true || candidatePair.nominated === true)
        ) {
          selectedPair = candidatePair;
        }
      }
      const localCandidateId = selectedPair?.localCandidateId;
      const localCandidate = typeof localCandidateId === "string" ? stats.get(localCandidateId) : null;
      const parsed = parseIceCandidateStats(localCandidate as unknown as Record<string, unknown> | null);
      this.updateDiagnostics(memberId, (diagnostics) => updateDiagnosticsSelectedCandidate(diagnostics, parsed));
      if (parsed) {
        console.log(`[HostStream] 已选 ICE 路径 (${memberId}): ${parsed.type} ${parsed.family} ${parsed.address ?? "unknown"}`);
      }
    } catch (err) {
      console.warn(`[HostStream] 读取 ICE 选中路径失败 (${memberId}):`, err);
    }
  }

  private applyTrackContentHint(): void {
    const profile = QUALITY_PROFILES[this.quality];
    this.localStream?.getVideoTracks().forEach((track) => {
      track.contentHint = profile.contentHint;
    });
  }

  private async applySenderQuality(sender: RTCRtpSender): Promise<void> {
    const profile = QUALITY_PROFILES[this.quality];
    const params = sender.getParameters() as ConfigurableSendParameters;
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    params.encodings[0] = {
      ...params.encodings[0],
      maxBitrate: profile.maxBitrate,
      maxFramerate: profile.maxFramerate,
      scaleResolutionDownBy: this.resolveScaleResolutionDownBy(profile)
    };
    params.degradationPreference = profile.degradationPreference;

    try {
      await sender.setParameters(params);
      console.log(
        `[HostStream] 已应用${profile.label}清晰度: maxBitrate=${profile.maxBitrate}, scale=${params.encodings[0].scaleResolutionDownBy}`
      );
    } catch (err) {
      delete params.degradationPreference;
      try {
        await sender.setParameters(params);
        console.log(`[HostStream] 已应用${profile.label}清晰度，当前浏览器不支持降级偏好参数`);
      } catch (fallbackErr) {
        console.warn(`[HostStream] 应用${profile.label}清晰度失败，浏览器将使用默认编码策略:`, fallbackErr);
      }
    }
  }

  private resolveScaleResolutionDownBy(profile: QualityProfile): number {
    if (!profile.targetHeight || !this.sourceVideoHeight || this.sourceVideoHeight <= profile.targetHeight) {
      return 1;
    }
    return Number((this.sourceVideoHeight / profile.targetHeight).toFixed(2));
  }
}
