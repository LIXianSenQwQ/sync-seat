import type { IceServerConfig, RoomMember } from "@sync-seat/shared";

type HostSignalType = "offer" | "answer" | "ice_candidate";

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
  /** 缓存在 setRemoteDescription 之前到达的 ICE candidate */
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();

  constructor(
    private readonly iceServers: IceServerConfig[],
    private readonly memberId: string,
    private readonly sendSignal: (targetMemberId: string, type: HostSignalType, payload: unknown) => void,
    private readonly onRemoteStream: (stream: MediaStream) => void,
    private readonly onConnectionState?: (memberId: string, state: RTCPeerConnectionState) => void
  ) {}

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
    return stream;
  }

  /**
   * 房主为在线观众建立推流连接。
   */
  async publishToMembers(members: RoomMember[]): Promise<void> {
    if (!this.localStream) return;
    for (const member of members) {
      if (member.memberId !== this.memberId && member.connected) {
        await this.ensurePeer(member.memberId, true);
      }
    }
  }

  /**
   * 处理远端 WebRTC 信令。
   */
  async handleSignal(fromMemberId: string, signalType: HostSignalType, payload: unknown): Promise<void> {
    const peer = await this.ensurePeer(fromMemberId, false);
    if (signalType === "offer") {
      await peer.setRemoteDescription(payload as RTCSessionDescriptionInit);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      this.sendSignal(fromMemberId, "answer", answer);
      this.flushPendingCandidates(fromMemberId, peer);
    }
    if (signalType === "answer") {
      await peer.setRemoteDescription(payload as RTCSessionDescriptionInit);
      this.flushPendingCandidates(fromMemberId, peer);
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

  stop(): void {
    this.peers.forEach((peer) => peer.close());
    this.peers.clear();
    this.localStream = null;
    this.remoteStream = null;
  }

  private async ensurePeer(targetMemberId: string, initiator: boolean): Promise<RTCPeerConnection> {
    const existing = this.peers.get(targetMemberId);
    if (existing) return existing;

    const peer = new RTCPeerConnection({ iceServers: this.iceServers });
    this.peers.set(targetMemberId, peer);

    // 步骤1：房主把本地视频轨道推给观众；观众没有本地轨道也能回 answer。
    this.localStream?.getTracks().forEach((track) => peer.addTrack(track, this.localStream!));

    // 步骤2：观众收到房主媒体流后交给页面播放器渲染。
    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream && stream !== this.remoteStream) {
        this.remoteStream = stream;
        this.onRemoteStream(stream);
      }
    };

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(targetMemberId, "ice_candidate", event.candidate);
      }
    };

    // 步骤3：监控 ICE 连接状态，便于排查跨网络连通性问题。
    peer.oniceconnectionstatechange = () => {
      console.log(`[HostStream] ICE 连接状态 (${targetMemberId}): ${peer.iceConnectionState}`);
      this.onConnectionState?.(targetMemberId, peer.iceConnectionState);
    };

    if (initiator) {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.sendSignal(targetMemberId, "offer", offer);
    }
    return peer;
  }
}
