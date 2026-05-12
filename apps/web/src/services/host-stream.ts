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

  constructor(
    private readonly iceServers: IceServerConfig[],
    private readonly memberId: string,
    private readonly sendSignal: (targetMemberId: string, type: HostSignalType, payload: unknown) => void,
    private readonly onRemoteStream: (stream: MediaStream) => void
  ) {}

  /**
   * 从房主本地播放器采集媒体流。
   *
   * @param video 房主本地 video 元素。
   * @returns 采集到的媒体流。
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
   *
   * @param members 房间成员列表。
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
   *
   * @param fromMemberId 信令来源成员。
   * @param signalType 信令类型。
   * @param payload 信令内容。
   */
  async handleSignal(fromMemberId: string, signalType: HostSignalType, payload: unknown): Promise<void> {
    const peer = await this.ensurePeer(fromMemberId, false);
    if (signalType === "offer") {
      await peer.setRemoteDescription(payload as RTCSessionDescriptionInit);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      this.sendSignal(fromMemberId, "answer", answer);
    }
    if (signalType === "answer") {
      await peer.setRemoteDescription(payload as RTCSessionDescriptionInit);
    }
    if (signalType === "ice_candidate" && payload) {
      await peer.addIceCandidate(payload as RTCIceCandidateInit);
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

    if (initiator) {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.sendSignal(targetMemberId, "offer", offer);
    }
    return peer;
  }
}
