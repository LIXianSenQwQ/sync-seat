import type { HostStreamQuality, IceServerConfig, RoomMember } from "@sync-seat/shared";
import {
  canReplaceMdnsCandidate,
  candidateMatchesHostStreamStage,
  createInitialHostStreamIceDiagnostics,
  parseIceCandidate,
  parseIceCandidateStats,
  replaceMdnsCandidateAddress,
  updateDiagnosticsConnectionState,
  updateDiagnosticsSelectedCandidate,
  updateDiagnosticsStage,
  updateDiagnosticsWithCandidate,
  type HostStreamIceStage,
  type HostStreamIceDiagnostics
} from "./ice-diagnostics";

type HostSignalType = "offer" | "answer" | "ice_candidate";

interface HostStreamDescriptionPayload {
  description: RTCSessionDescriptionInit;
  stage: HostStreamIceStage;
}

interface HostStreamCandidatePayload {
  candidate: RTCIceCandidateInit;
  stage: HostStreamIceStage;
}

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

/** 房主推流暂时只尝试 IPv6 直连，不通后直接走 TURN 中继。 */
export const HOST_STREAM_ICE_STAGE_ORDER: HostStreamIceStage[] = ["ipv6", "relay"];
/** 每个阶段等待浏览器 ICE 检查稳定成功的时间，超时后进入下一阶段。 */
const ICE_STAGE_TIMEOUT_MS = 8_000;

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
  private peerStages = new Map<string, HostStreamIceStage>();
  private iceDiagnostics = new Map<string, HostStreamIceDiagnostics>();
  private stageTimers = new Map<string, number>();
  private videoSenders = new Set<RTCRtpSender>();
  private videoSendersByMember = new Map<string, Set<RTCRtpSender>>();
  private memberQualities = new Map<string, HostStreamQuality>();
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
    await Promise.all(Array.from(this.videoSenders).map((sender) => this.applySenderQuality(sender, quality)));
  }

  /**
   * 按观众单独切换房主推流清晰度，避免一个观众的网络选择影响其他观众。
   */
  async setMemberQuality(memberId: string, quality: HostStreamQuality): Promise<void> {
    this.memberQualities.set(memberId, quality);
    const senders = this.videoSendersByMember.get(memberId);
    if (!senders) return;
    await Promise.all(Array.from(senders).map((sender) => this.applySenderQuality(sender, quality)));
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
    if (signalType === "offer") {
      const { description, stage } = this.resolveDescriptionPayload(payload);
      const currentStage = this.peerStages.get(fromMemberId);
      if (currentStage && this.shouldIgnoreStaleStage(currentStage, stage)) {
        console.warn(`[HostStream] 忽略过期 offer from ${fromMemberId}，stage=${stage}`);
        return;
      }
      const peer = await this.ensurePeerForRemoteOffer(fromMemberId, stage);
      console.log(`[HostStream] 处理 offer from ${fromMemberId}，stage=${stage}，设置远端描述并创建应答`);
      await peer.setRemoteDescription(description);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      this.sendSignal(fromMemberId, "answer", this.createDescriptionPayload(answer, stage));
      await this.flushPendingCandidates(fromMemberId, peer);
      console.log(`[HostStream] 应答已发送 to ${fromMemberId}`);
    }
    if (signalType === "answer") {
      const { description, stage } = this.resolveDescriptionPayload(payload);
      const peer = this.peers.get(fromMemberId);
      if (!peer || this.peerStages.get(fromMemberId) !== stage) {
        console.warn(`[HostStream] 忽略过期 answer from ${fromMemberId}，stage=${stage}`);
        return;
      }
      console.log(`[HostStream] 处理 answer from ${fromMemberId}，stage=${stage}，设置远端描述`);
      await peer.setRemoteDescription(description);
      await this.flushPendingCandidates(fromMemberId, peer);
    }
    if (signalType === "ice_candidate" && payload) {
      const { candidate, stage } = this.resolveCandidatePayload(payload);
      const currentStage = this.peerStages.get(fromMemberId);
      if (currentStage && this.shouldIgnoreStaleStage(currentStage, stage)) {
        console.warn(`[HostStream] 忽略过期 ICE candidate from ${fromMemberId}，stage=${stage}`);
        return;
      }
      const peer = await this.ensurePeerForRemoteCandidate(fromMemberId, stage);
      this.recordCandidate(fromMemberId, candidate);
      if (peer.remoteDescription) {
        await this.addRemoteCandidate(fromMemberId, peer, candidate);
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
      await this.addRemoteCandidate(memberId, peer, candidate);
    }
  }

  private async addRemoteCandidate(memberId: string, peer: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await peer.addIceCandidate(candidate);
    } catch (err) {
      console.warn(`[HostStream] 忽略当前 ICE 阶段不兼容的远端候选 (${memberId}):`, err);
    }
  }

  stop(): void {
    this.stageTimers.forEach((timer) => window.clearTimeout(timer));
    this.stageTimers.clear();
    this.peers.forEach((peer) => peer.close());
    this.peers.clear();
    this.peerInitiators.clear();
    this.peerStages.clear();
    this.iceDiagnostics.clear();
    this.videoSenders.clear();
    this.videoSendersByMember.clear();
    this.memberQualities.clear();
    this.localStream = null;
    this.remoteStream = null;
    this.sourceVideoHeight = 0;
  }

  private async ensurePeer(targetMemberId: string, initiator: boolean): Promise<RTCPeerConnection> {
    const existing = this.peers.get(targetMemberId);
    if (existing) return existing;

    return this.createPeer(targetMemberId, initiator, "ipv6");
  }

  private async ensurePeerForRemoteOffer(targetMemberId: string, stage: HostStreamIceStage): Promise<RTCPeerConnection> {
    const existing = this.peers.get(targetMemberId);
    if (existing && this.peerStages.get(targetMemberId) === stage) return existing;
    if (existing) {
      this.clearStageTimer(targetMemberId);
      existing.close();
      this.discardPeerMediaState(targetMemberId);
      this.peers.delete(targetMemberId);
      this.pendingCandidates.delete(targetMemberId);
    }
    return this.createPeer(targetMemberId, false, stage);
  }

  private async ensurePeerForRemoteCandidate(targetMemberId: string, stage: HostStreamIceStage): Promise<RTCPeerConnection> {
    const existing = this.peers.get(targetMemberId);
    if (existing && this.peerStages.get(targetMemberId) === stage) return existing;
    if (existing) {
      if (this.shouldIgnoreStaleStage(this.peerStages.get(targetMemberId) ?? "ipv6", stage)) {
        return existing;
      }
      this.clearStageTimer(targetMemberId);
      existing.close();
      this.discardPeerMediaState(targetMemberId);
      this.peers.delete(targetMemberId);
      this.pendingCandidates.delete(targetMemberId);
    }
    return this.createPeer(targetMemberId, false, stage);
  }

  private shouldIgnoreStaleStage(currentStage: HostStreamIceStage, incomingStage: HostStreamIceStage): boolean {
    return HOST_STREAM_ICE_STAGE_ORDER.indexOf(incomingStage) < HOST_STREAM_ICE_STAGE_ORDER.indexOf(currentStage);
  }

  private async createPeer(targetMemberId: string, initiator: boolean, stage: HostStreamIceStage): Promise<RTCPeerConnection> {
    const peer = new RTCPeerConnection({ iceServers: this.resolveIceServers(stage), iceTransportPolicy: "all" });
    this.peers.set(targetMemberId, peer);
    this.peerInitiators.set(targetMemberId, initiator);
    this.peerStages.set(targetMemberId, stage);
    this.pendingCandidates.delete(targetMemberId);
    this.updateDiagnostics(targetMemberId, (diagnostics) => updateDiagnosticsStage(diagnostics, stage));
    this.ensureDiagnostics(targetMemberId);
    console.log(`[HostStream] 创建 PeerConnection (${targetMemberId})，initiator=${initiator}，stage=${stage}`);

    // 步骤1：房主把本地视频轨道推给观众；观众没有本地轨道也能回 answer。
    const tracks = this.localStream?.getTracks() ?? [];
    console.log(`[HostStream] 添加 ${tracks.length} 条轨道到 PeerConnection (${targetMemberId})`);
    for (const track of tracks) {
      const sender = peer.addTrack(track, this.localStream!);
      if (track.kind === "video") {
        this.videoSenders.add(sender);
        const senders = this.videoSendersByMember.get(targetMemberId) ?? new Set<RTCRtpSender>();
        senders.add(sender);
        this.videoSendersByMember.set(targetMemberId, senders);
        await this.applySenderQuality(sender, this.memberQualities.get(targetMemberId) ?? this.quality);
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
        const stageNow = this.peerStages.get(targetMemberId) ?? stage;
        const parsed = this.recordCandidate(targetMemberId, event.candidate);
        // Chrome mDNS 隐藏把局域网 IP 换成 .local 地址
        // address 可能为 null 或直接就是 .local 主机名（取决于 Chrome 版本）
        if (this.localIp && canReplaceMdnsCandidate(event.candidate, this.localIp)) {
          const fixedCandidate = replaceMdnsCandidateAddress(event.candidate, this.localIp);
          const fixedParsed = this.recordCandidate(targetMemberId, fixedCandidate);
          console.log(`[HostStream] ICE 候选 (${targetMemberId}, host): 修复 mDNS → ${this.localIp}`);
          if (candidateMatchesHostStreamStage(stageNow, fixedParsed)) {
            this.sendSignal(targetMemberId, "ice_candidate", this.createCandidatePayload(fixedCandidate, stageNow));
          }
          return;
        }
        if (parsed?.isMdns && this.localIp) {
          console.log(`[HostStream] ICE 候选 (${targetMemberId}, host): 保留 mDNS，whoami 返回的 ${this.localIp} 不是私有 IPv4`);
        }
        console.log(
          `[HostStream] ICE 候选 (${targetMemberId}, ${parsed?.type ?? "unknown"}, stage=${stageNow}): ${parsed?.protocol ?? "unknown"} ${parsed?.address ?? "unknown"}:${parsed?.port ?? ""}`
        );
        if (candidateMatchesHostStreamStage(stageNow, parsed)) {
          this.sendSignal(targetMemberId, "ice_candidate", this.createCandidatePayload(event.candidate, stageNow));
        }
      }
    };

    // 步骤3：监控 ICE 连接状态，便于排查跨网络连通性问题。
    peer.oniceconnectionstatechange = () => {
      console.log(`[HostStream] ICE 连接状态 (${targetMemberId}): ${peer.iceConnectionState}`);
      this.onConnectionState?.(targetMemberId, peer.iceConnectionState);
      this.updateDiagnostics(targetMemberId, (diagnostics) => updateDiagnosticsConnectionState(diagnostics, peer.iceConnectionState));
      if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
        this.clearStageTimer(targetMemberId);
        void this.refreshSelectedCandidate(targetMemberId, peer);
      }
      if (peer.iceConnectionState === "failed") {
        void this.fallbackIceStage(targetMemberId, peer);
      }
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "closed" || peer.connectionState === "failed") {
        this.discardPeerMediaState(targetMemberId);
      }
    };

    if (initiator) {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.sendSignal(targetMemberId, "offer", this.createDescriptionPayload(offer, stage));
      this.armStageTimer(targetMemberId, peer);
    }
    return peer;
  }

  private createDescriptionPayload(description: RTCSessionDescriptionInit, stage: HostStreamIceStage): HostStreamDescriptionPayload {
    return { description, stage };
  }

  private createCandidatePayload(candidate: RTCIceCandidateInit, stage: HostStreamIceStage): HostStreamCandidatePayload {
    return { candidate, stage };
  }

  private resolveDescriptionPayload(payload: unknown): HostStreamDescriptionPayload {
    const envelope = payload as Partial<HostStreamDescriptionPayload> | null;
    const description = envelope?.description ?? (payload as RTCSessionDescriptionInit);
    const stage = envelope?.stage === "relay" ? envelope.stage : "ipv6";
    return { description, stage };
  }

  private resolveCandidatePayload(payload: unknown): HostStreamCandidatePayload {
    const envelope = payload as Partial<HostStreamCandidatePayload> | null;
    const candidate = envelope?.candidate ?? (payload as RTCIceCandidateInit);
    const stage = envelope?.stage === "relay" ? envelope.stage : "ipv6";
    return { candidate, stage };
  }

  private recordCandidate(memberId: string, candidate: RTCIceCandidateInit | RTCIceCandidate): ReturnType<typeof parseIceCandidate> {
    const parsed = parseIceCandidate(candidate);
    this.updateDiagnostics(memberId, (diagnostics) => updateDiagnosticsWithCandidate(diagnostics, parsed));
    return parsed;
  }

  private ensureDiagnostics(memberId: string): HostStreamIceDiagnostics {
    const existing = this.iceDiagnostics.get(memberId);
    if (existing) return existing;
    const diagnostics = createInitialHostStreamIceDiagnostics(this.peerStages.get(memberId) ?? "ipv6");
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

  private resolveIceServers(stage: HostStreamIceStage): IceServerConfig[] {
    return resolveHostStreamIceServersForStage(stage, this.iceServers);
  }

  private armStageTimer(memberId: string, peer: RTCPeerConnection): void {
    this.clearStageTimer(memberId);
    const timer = window.setTimeout(() => {
      if (peer.iceConnectionState !== "connected" && peer.iceConnectionState !== "completed") {
        void this.fallbackIceStage(memberId, peer);
      }
    }, ICE_STAGE_TIMEOUT_MS);
    this.stageTimers.set(memberId, timer);
  }

  private clearStageTimer(memberId: string): void {
    const timer = this.stageTimers.get(memberId);
    if (timer) window.clearTimeout(timer);
    this.stageTimers.delete(memberId);
  }

  private async fallbackIceStage(memberId: string, peer: RTCPeerConnection): Promise<void> {
    if (!this.peerInitiators.get(memberId)) return;
    if (this.peers.get(memberId) !== peer) return;
    const currentStage = this.peerStages.get(memberId) ?? "ipv6";
    const nextStage = this.resolveNextAvailableStage(currentStage);
    if (!nextStage) return;
    this.clearStageTimer(memberId);
    peer.close();
    this.discardPeerMediaState(memberId);
    this.peers.delete(memberId);
    this.pendingCandidates.delete(memberId);
    console.warn(`[HostStream] ICE ${currentStage} 阶段失败，回落到 ${nextStage} 阶段 (${memberId})`);
    await this.createPeer(memberId, true, nextStage);
  }

  private resolveNextAvailableStage(currentStage: HostStreamIceStage): HostStreamIceStage | null {
    const currentIndex = HOST_STREAM_ICE_STAGE_ORDER.indexOf(currentStage);
    for (const stage of HOST_STREAM_ICE_STAGE_ORDER.slice(currentIndex + 1)) {
      if (stage === "ipv6" || this.resolveIceServers(stage).length > 0) return stage;
      console.warn(`[HostStream] ${stage} 阶段缺少 ICE 服务器配置，跳过该阶段`);
    }
    return null;
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

  private async applySenderQuality(sender: RTCRtpSender, quality = this.quality): Promise<void> {
    const profile = QUALITY_PROFILES[quality];
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

  private discardPeerMediaState(memberId: string): void {
    const senders = this.videoSendersByMember.get(memberId);
    senders?.forEach((sender) => this.videoSenders.delete(sender));
    this.videoSendersByMember.delete(memberId);
  }

  private resolveScaleResolutionDownBy(profile: QualityProfile): number {
    if (!profile.targetHeight || !this.sourceVideoHeight || this.sourceVideoHeight <= profile.targetHeight) {
      return 1;
    }
    return Number((this.sourceVideoHeight / profile.targetHeight).toFixed(2));
  }
}

export function resolveHostStreamIceServersForStage(stage: HostStreamIceStage, iceServers: IceServerConfig[]): IceServerConfig[] {
  if (stage !== "relay") return [];
  return iceServers.flatMap((server) => {
    const urls = resolveServerUrls(server).filter((url) => url.startsWith("turn:") || url.startsWith("turns:"));
    if (urls.length === 0) return [];
    return [{
      ...server,
      urls: Array.isArray(server.urls) ? urls : urls[0]!
    }];
  });
}

function resolveServerUrls(server: IceServerConfig): string[] {
  return Array.isArray(server.urls) ? server.urls : [server.urls];
}
