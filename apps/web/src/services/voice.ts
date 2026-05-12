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

  constructor(
    private readonly iceServers: IceServerConfig[],
    private readonly memberId: string,
    private readonly sendSignal: (targetMemberId: string, type: "offer" | "answer" | "ice_candidate", payload: unknown) => void
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
    }
    if (signalType === "answer") {
      await peer.setRemoteDescription(payload as RTCSessionDescriptionInit);
    }
    if (signalType === "ice_candidate" && payload) {
      await peer.addIceCandidate(payload as RTCIceCandidateInit);
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

    if (initiator) {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.sendSignal(targetMemberId, "offer", offer);
    }
    return peer;
  }
}
