import type { IceServerConfig, RoomMember } from "@sync-seat/shared";

/**
 * WebRTC P2P 语音管理器。
 *
 * @author 清羽
 */
export class VoiceMesh {
  private localStream: MediaStream | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private remoteAudio = new Map<string, HTMLAudioElement>();
  private volume = 1;
  /** 缓存在 setRemoteDescription 之前到达的 ICE candidate */
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();

  constructor(
    private readonly iceServers: IceServerConfig[],
    private readonly memberId: string,
    private readonly sendSignal: (targetMemberId: string, type: "offer" | "answer" | "ice_candidate", payload: unknown) => void,
    private readonly onConnectionState?: (memberId: string, state: RTCPeerConnectionState) => void
  ) {}

  async join(members: RoomMember[]): Promise<void> {
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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
    this.remoteAudio.forEach((audio) => audio.remove());
    this.remoteAudio.clear();
  }

  setMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.remoteAudio.forEach((audio) => {
      audio.volume = volume;
    });
  }

  async handleSignal(fromMemberId: string, signalType: "offer" | "answer" | "ice_candidate", payload: unknown): Promise<void> {
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

  private async ensurePeer(targetMemberId: string, initiator: boolean): Promise<RTCPeerConnection> {
    const existing = this.peers.get(targetMemberId);
    if (existing) return existing;

    const peer = new RTCPeerConnection({ iceServers: this.iceServers });
    this.peers.set(targetMemberId, peer);

    // 步骤1：本地音频轨道加入每条 P2P 连接。
    this.localStream?.getTracks().forEach((track) => peer.addTrack(track, this.localStream!));

    // 步骤2：远端音轨以隐藏 audio 元素播放，并受本地总音量控制。
    peer.ontrack = (event) => {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.volume = this.volume;
      audio.srcObject = event.streams[0];
      document.body.appendChild(audio);
      this.remoteAudio.set(targetMemberId, audio);
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
}
