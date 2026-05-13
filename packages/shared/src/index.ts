/**
 * 可浏览的网盘条目。
 *
 * @author 清羽
 */
export interface DriveEntry {
  name: string;
  path: string;
  type: "directory" | "video" | "subtitle" | "file";
  size?: number;
  modifiedAt?: string;
}

/**
 * 房间成员的临时身份。
 *
 * @author 清羽
 */
export interface RoomMember {
  memberId: string;
  nickname: string;
  joinedAt: string;
  connected: boolean;
  voiceJoined: boolean;
  muted: boolean;
}

/**
 * 房间当前视频信息。
 *
 * @author 清羽
 */
export interface CurrentVideo {
  filePath: string;
  fileName: string;
  playUrl: string;
  mimeType?: string;
  size?: number;
}

/**
 * 房间当前字幕信息。
 *
 * @author 清羽
 */
export interface CurrentSubtitle {
  filePath: string;
  fileName: string;
  format: "vtt" | "srt";
  trackUrl: string;
}

/**
 * 服务端权威播放状态。
 *
 * @author 清羽
 */
export interface PlaybackState {
  playing: boolean;
  positionSeconds: number;
  playbackRate: number;
  stateUpdatedAt: string;
  version: number;
}

/**
 * 房间观影模式。
 *
 * @author 清羽
 */
export type WatchMode = "direct" | "host-stream";

/**
 * 房主推流模式的开播状态。
 *
 * @author 清羽
 */
export interface HostStreamState {
  streaming: boolean;
  hostMemberId: string;
  fileName: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  version: number;
}

/**
 * 观众请求房主执行的播放控制动作。
 *
 * @author 清羽
 */
export interface HostControlCommand {
  action: "play" | "pause" | "seek" | "playback_rate_change";
  positionSeconds?: number;
  playbackRate?: number;
}

/**
 * 前端可见的完整房间状态。
 *
 * @author 清羽
 */
export interface RoomState {
  roomId: string;
  roomCode: string;
  watchMode: WatchMode;
  hasPassword: boolean;
  ownerId: string;
  members: RoomMember[];
  currentVideo: CurrentVideo | null;
  currentSubtitle: CurrentSubtitle | null;
  playbackState: PlaybackState;
  hostStreamState: HostStreamState | null;
  createdAt: string;
  updatedAt: string;
  emptySince: string | null;
  maxMembers: number;
}

export interface CreateRoomRequest {
  memberId: string;
  nickname: string;
  password?: string;
  watchMode?: WatchMode;
}

export interface JoinRoomRequest {
  memberId: string;
  nickname: string;
  password?: string;
}

export interface CreateRoomResponse {
  room: RoomState;
  inviteUrl: string;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type ClientRoomEvent =
  | { type: "load_video"; roomCode: string; memberId: string; filePath: string }
  | { type: "select_subtitle"; roomCode: string; memberId: string; filePath: string | null }
  | { type: "play"; roomCode: string; memberId: string; positionSeconds: number }
  | { type: "pause"; roomCode: string; memberId: string; positionSeconds: number }
  | { type: "seek"; roomCode: string; memberId: string; positionSeconds: number }
  | { type: "playback_rate_change"; roomCode: string; memberId: string; playbackRate: number; positionSeconds: number }
  | { type: "voice_join"; roomCode: string; memberId: string }
  | { type: "voice_leave"; roomCode: string; memberId: string }
  | { type: "voice_mute"; roomCode: string; memberId: string; muted: boolean }
  | { type: "voice_offer"; roomCode: string; memberId: string; targetMemberId: string; description: unknown }
  | { type: "voice_answer"; roomCode: string; memberId: string; targetMemberId: string; description: unknown }
  | { type: "voice_ice_candidate"; roomCode: string; memberId: string; targetMemberId: string; candidate: unknown }
  | { type: "host_stream_start"; roomCode: string; memberId: string; fileName: string }
  | { type: "host_stream_stop"; roomCode: string; memberId: string }
  | { type: "host_stream_offer"; roomCode: string; memberId: string; targetMemberId: string; description: unknown }
  | { type: "host_stream_answer"; roomCode: string; memberId: string; targetMemberId: string; description: unknown }
  | { type: "host_stream_ice_candidate"; roomCode: string; memberId: string; targetMemberId: string; candidate: unknown }
  | ({ type: "host_control_request"; roomCode: string; memberId: string } & HostControlCommand);

export type ServerRoomEvent =
  | { type: "room_state"; room: RoomState }
  | { type: "room_error"; message: string }
  | { type: "voice_signal"; fromMemberId: string; signalType: "offer" | "answer" | "ice_candidate"; payload: unknown }
  | { type: "host_stream_signal"; fromMemberId: string; signalType: "offer" | "answer" | "ice_candidate"; payload: unknown }
  | ({ type: "host_control_command"; fromMemberId: string } & HostControlCommand)
  | { type: "room_closed"; reason: string }
  | { type: "client_ip"; ip: string };
