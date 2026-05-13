import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { PLAYBACK_RATE_OPTIONS, type CurrentSubtitle, type HostStreamState, type PlaybackState, type RoomState, type WatchMode } from "@sync-seat/shared";
import { AlistService } from "../drive/alist.service.js";
import { SubtitleService } from "../drive/subtitle.service.js";
import { logInfo, logWarn } from "../logging/app-logger.js";
import { clonePublicRoom, type JoinResult, type StoredRoom } from "./room.types.js";

const MAX_MEMBERS = 3;
const OWNER_GRACE_MS = 60_000;
const EMPTY_ROOM_TTL_MS = 60_000;
const ROOM_CODE_DIGITS = 4;
const ROOM_CODE_LIMIT = 10 ** ROOM_CODE_DIGITS;

/**
 * 房间内存状态管理服务。
 *
 * @author 清羽
 */
@Injectable()
export class RoomService implements OnModuleInit, OnModuleDestroy {
  private readonly rooms = new Map<string, StoredRoom>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly alist: AlistService,
    private readonly subtitleService: SubtitleService
  ) {}

  onModuleInit(): void {
    // 步骤1：定时执行生命周期清理，确保房主转让和空房释放不依赖用户新操作。
    this.sweepTimer = setInterval(() => this.sweep(), 10_000);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * 创建空房间。
   *
   * @param memberId 创建者成员标识。
   * @param nickname 创建者昵称。
   * @param password 可选加入密码。
   * @returns 创建后的公开房间状态。
   */
  createRoom(memberId: string, nickname: string, password?: string, watchMode: WatchMode = "direct"): RoomState {
    const now = new Date().toISOString();
    const roomCode = this.createRoomCode();
    const normalizedMode = watchMode === "host-stream" ? "host-stream" : "direct";
    const room: StoredRoom = {
      roomId: randomUUID(),
      roomCode,
      watchMode: normalizedMode,
      hasPassword: Boolean(password),
      ownerId: memberId,
      members: [
        {
          memberId,
          nickname: this.normalizeNickname(nickname),
          joinedAt: now,
          connected: true,
          voiceJoined: false,
          muted: false
        }
      ],
      currentVideo: null,
      currentSubtitle: null,
      playbackState: this.initialPlaybackState(now),
      hostStreamState: normalizedMode === "host-stream" ? this.initialHostStreamState(memberId) : null,
      createdAt: now,
      updatedAt: now,
      emptySince: null,
      maxMembers: MAX_MEMBERS,
      passwordHash: password ? hashPassword(password) : null,
      ownerDisconnectedAt: null,
      memberOrder: [memberId]
    };
    this.rooms.set(roomCode, room);
    logInfo("RoomService", "创建房间", {
      roomCode,
      memberId,
      watchMode: normalizedMode,
      hasPassword: Boolean(password)
    });
    return clonePublicRoom(room);
  }

  /**
   * 加入房间或恢复已有成员连接。
   *
   * @param roomCode 房间码。
   * @param memberId 成员标识。
   * @param nickname 成员昵称。
   * @param password 可选房间密码。
   * @returns 房间状态和是否为重连。
   */
  joinRoom(roomCode: string, memberId: string, nickname: string, password?: string): JoinResult {
    const room = this.getStoredRoom(roomCode);

    // 步骤1：已有成员视为断线重连，保留进入顺序和语音默认关闭。
    const existing = room.members.find((member) => member.memberId === memberId);
    const now = new Date().toISOString();
    if (existing) {
      existing.connected = true;
      existing.nickname = this.normalizeNickname(nickname);
      room.emptySince = null;
      if (room.ownerId === memberId) {
        room.ownerDisconnectedAt = null;
      }
      this.touch(room);
      logInfo("RoomService", "成员通过 REST 重连房间", {
        roomCode: room.roomCode,
        memberId,
        connectedMembers: room.members.filter((member) => member.connected).length
      });
      return { room: clonePublicRoom(room), reconnected: true };
    }

    // 步骤2：新成员受房间人数上限约束。
    this.assertPassword(room, password);
    if (room.members.filter((member) => member.connected).length >= MAX_MEMBERS) {
      throw new ForbiddenException("房间人数已满");
    }
    room.members.push({
      memberId,
      nickname: this.normalizeNickname(nickname),
      joinedAt: now,
      connected: true,
      voiceJoined: false,
      muted: false
    });
    room.memberOrder.push(memberId);
    room.emptySince = null;
    this.touch(room);
    logInfo("RoomService", "成员加入房间", {
      roomCode: room.roomCode,
      memberId,
      connectedMembers: room.members.filter((member) => member.connected).length
    });
    return { room: clonePublicRoom(room), reconnected: false };
  }

  /**
   * 恢复已有成员的实时连接，供 WebSocket 自动重连使用。
   *
   * @param roomCode 房间码。
   * @param memberId 成员标识。
   * @param nickname 可选昵称；为空时保留原昵称。
   * @returns 恢复后的房间状态。
   */
  reconnectMember(roomCode: string, memberId: string, nickname?: string): RoomState {
    const room = this.getStoredRoom(roomCode);
    const existing = room.members.find((member) => member.memberId === memberId);
    if (!existing) {
      throw new ForbiddenException("请先通过 REST API 加入房间");
    }

    // 步骤1：WS 自动重连只恢复已有身份，不重新校验密码，也不新增成员。
    existing.connected = true;
    if (nickname) {
      existing.nickname = this.normalizeNickname(nickname);
    }
    room.emptySince = null;
    if (room.ownerId === memberId) {
      room.ownerDisconnectedAt = null;
    }
    this.touch(room);
    logInfo("RoomService", "成员通过 WebSocket 恢复连接", {
      roomCode: room.roomCode,
      memberId,
      connectedMembers: room.members.filter((member) => member.connected).length
    });
    return clonePublicRoom(room);
  }

  /**
   * 标记成员离线，并触发房主保留或空房计时。
   *
   * @param roomCode 房间码。
   * @param memberId 成员标识。
   * @returns 更新后的房间状态。
   */
  leaveRoom(roomCode: string, memberId: string): RoomState {
    const room = this.getStoredRoom(roomCode);
    const member = room.members.find((item) => item.memberId === memberId);
    if (!member) {
      return clonePublicRoom(room);
    }

    const now = new Date().toISOString();
    member.connected = false;
    member.voiceJoined = false;
    member.muted = false;
    if (room.ownerId === memberId) {
      room.ownerDisconnectedAt = now;
      if (room.watchMode === "host-stream" && room.hostStreamState?.streaming) {
        room.hostStreamState = {
          ...room.hostStreamState,
          streaming: false,
          stoppedAt: now,
          version: room.hostStreamState.version + 1
        };
      }
    }
    if (!room.members.some((item) => item.connected)) {
      room.emptySince = now;
    }
    this.touch(room);
    logInfo("RoomService", "成员离开房间", {
      roomCode: room.roomCode,
      memberId,
      ownerId: room.ownerId,
      connectedMembers: room.members.filter((item) => item.connected).length,
      emptySince: room.emptySince
    });
    return clonePublicRoom(room);
  }

  /**
   * 清理超时状态，包括房主转让和空房释放。
   *
   * @param nowMs 当前时间戳，测试可注入。
   * @returns 被释放的房间码列表。
   */
  sweep(nowMs = Date.now()): string[] {
    const removed: string[] = [];
    for (const [roomCode, room] of this.rooms) {
      // 步骤1：房主离线超过保留窗口后，直链房间转让房主，房主推流房间释放。
      if (room.ownerDisconnectedAt && nowMs - Date.parse(room.ownerDisconnectedAt) >= OWNER_GRACE_MS) {
        if (room.watchMode === "host-stream") {
          this.rooms.delete(roomCode);
          removed.push(roomCode);
          logWarn("RoomService", "房主推流房间因房主离线超时释放", { roomCode });
          continue;
        }
        const nextOwnerId = room.memberOrder.find((id) => room.members.some((m) => m.memberId === id && m.connected));
        if (nextOwnerId) {
          room.ownerId = nextOwnerId;
          room.ownerDisconnectedAt = null;
          this.touch(room);
          logInfo("RoomService", "房主离线超时后转让房主", {
            roomCode,
            nextOwnerId
          });
        }
      }

      // 步骤2：空房超过 TTL 后释放内存状态。
      if (room.emptySince && nowMs - Date.parse(room.emptySince) >= EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(roomCode);
        removed.push(roomCode);
        logInfo("RoomService", "空房间超时释放", { roomCode });
      }
    }
    return removed;
  }

  getRoom(roomCode: string): RoomState {
    return clonePublicRoom(this.getStoredRoom(roomCode));
  }

  /**
   * 加载或更换当前视频，并重置播放状态。
   *
   * @param roomCode 房间码。
   * @param filePath 视频路径。
   * @returns 更新后的房间状态。
   */
  async loadVideo(roomCode: string, filePath: string): Promise<RoomState> {
    const room = this.getStoredRoom(roomCode);
    this.assertDirectMode(room);
    const video = await this.alist.getVideo(filePath);
    room.currentVideo = {
      ...video,
      playUrl: `/api/rooms/${room.roomCode}/video`
    };
    room.currentSubtitle = null;
    room.playbackState = this.nextPlaybackState(room, {
      playing: false,
      positionSeconds: 0,
      playbackRate: 1
    });
    this.touch(room);
    logInfo("RoomService", "房间加载视频", {
      roomCode: room.roomCode,
      filePath: video.filePath,
      fileName: video.fileName,
      size: video.size
    });
    return clonePublicRoom(room);
  }

  /**
   * 选择或清除当前字幕。
   *
   * @param roomCode 房间码。
   * @param filePath 字幕路径，传空表示清除。
   * @returns 更新后的房间状态。
   */
  selectSubtitle(roomCode: string, filePath: string | null): RoomState {
    const room = this.getStoredRoom(roomCode);
    this.assertDirectMode(room);
    room.currentSubtitle = filePath ? this.subtitleService.buildCurrentSubtitle(filePath, roomCode) : null;
    this.touch(room);
    logInfo("RoomService", "房间切换字幕", {
      roomCode: room.roomCode,
      filePath,
      fileName: room.currentSubtitle?.fileName ?? null
    });
    return clonePublicRoom(room);
  }

  /**
   * 更新播放状态，服务端按接收顺序递增版本号。
   *
   * @param roomCode 房间码。
   * @param patch 播放状态变更。
   * @returns 更新后的房间状态。
   */
  updatePlayback(roomCode: string, patch: Pick<PlaybackState, "positionSeconds"> & Partial<Pick<PlaybackState, "playing" | "playbackRate">>): RoomState {
    const room = this.getStoredRoom(roomCode);
    this.assertDirectMode(room);
    if (patch.playbackRate !== undefined && !this.isAllowedPlaybackRate(patch.playbackRate)) {
      throw new BadRequestException(`只支持 ${PLAYBACK_RATE_OPTIONS.map((rate) => `${rate}x`).join("、")} 倍速`);
    }
    room.playbackState = this.nextPlaybackState(room, patch);
    this.touch(room);
    logInfo("RoomService", "房间播放状态变更", {
      roomCode: room.roomCode,
      playing: room.playbackState.playing,
      positionSeconds: room.playbackState.positionSeconds,
      playbackRate: room.playbackState.playbackRate,
      version: room.playbackState.version
    });
    return clonePublicRoom(room);
  }

  updateVoice(roomCode: string, memberId: string, patch: { voiceJoined?: boolean; muted?: boolean }): RoomState {
    const room = this.getStoredRoom(roomCode);
    const member = room.members.find((item) => item.memberId === memberId);
    if (!member) {
      throw new NotFoundException("成员不存在");
    }
    member.voiceJoined = patch.voiceJoined ?? member.voiceJoined;
    member.muted = patch.muted ?? member.muted;
    this.touch(room);
    logInfo("RoomService", "成员语音状态变更", {
      roomCode: room.roomCode,
      memberId,
      voiceJoined: member.voiceJoined,
      muted: member.muted
    });
    return clonePublicRoom(room);
  }

  getCurrentSubtitle(roomCode: string): CurrentSubtitle | null {
    return this.getStoredRoom(roomCode).currentSubtitle;
  }

  /**
   * 解析房间当前视频的真实播放地址，用于 HTTP 302 跳转。
   *
   * @param roomCode 房间码。
   * @returns AList/OpenList 当前视频真实地址。
   */
  async resolveCurrentVideoUrl(roomCode: string): Promise<string> {
    const room = this.getStoredRoom(roomCode);
    this.assertDirectMode(room);
    if (!room.currentVideo) {
      throw new NotFoundException("房间尚未选择视频");
    }
    return this.alist.resolveFileUrl(room.currentVideo.filePath);
  }

  /**
   * 打开房间当前视频的代理读取流。
   *
   * @param roomCode 房间码。
   * @param range 浏览器 Range 请求头。
   * @returns 上游文件响应。
   */
  async openCurrentVideoStream(roomCode: string, range?: string): Promise<Response> {
    const room = this.getStoredRoom(roomCode);
    this.assertDirectMode(room);
    if (!room.currentVideo) {
      throw new NotFoundException("房间尚未选择视频");
    }
    return this.alist.openFileStream(room.currentVideo.filePath, range);
  }

  /**
   * 标记房主推流开始。
   *
   * @param roomCode 房间码。
   * @param memberId 发起成员。
   * @param fileName 房主本地视频文件名。
   * @returns 更新后的房间状态。
   */
  startHostStream(roomCode: string, memberId: string, fileName: string): RoomState {
    const room = this.getStoredRoom(roomCode);
    this.assertHostStreamOwner(room, memberId);
    const now = new Date().toISOString();
    const previous = room.hostStreamState ?? this.initialHostStreamState(memberId);
    room.hostStreamState = {
      streaming: true,
      hostMemberId: memberId,
      fileName: fileName.trim().slice(0, 180) || "本地视频",
      startedAt: now,
      stoppedAt: null,
      version: previous.version + 1
    };
    this.touch(room);
    logInfo("RoomService", "房主推流开始", {
      roomCode: room.roomCode,
      memberId,
      fileName: room.hostStreamState.fileName,
      version: room.hostStreamState.version
    });
    return clonePublicRoom(room);
  }

  /**
   * 标记房主推流停止。
   *
   * @param roomCode 房间码。
   * @param memberId 发起成员。
   * @returns 更新后的房间状态。
   */
  stopHostStream(roomCode: string, memberId: string): RoomState {
    const room = this.getStoredRoom(roomCode);
    this.assertHostStreamOwner(room, memberId);
    const previous = room.hostStreamState ?? this.initialHostStreamState(memberId);
    room.hostStreamState = {
      ...previous,
      streaming: false,
      stoppedAt: new Date().toISOString(),
      version: previous.version + 1
    };
    this.touch(room);
    logInfo("RoomService", "房主推流停止", {
      roomCode: room.roomCode,
      memberId,
      version: room.hostStreamState.version
    });
    return clonePublicRoom(room);
  }

  getOwnerId(roomCode: string): string {
    return this.getStoredRoom(roomCode).ownerId;
  }

  private getStoredRoom(roomCode: string): StoredRoom {
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) {
      throw new NotFoundException("房间不存在");
    }
    return room;
  }

  private createRoomCode(): string {
    // 步骤1：优先随机生成 4 位数字房间号，降低连续创建时的可预测性。
    for (let attempt = 0; attempt < ROOM_CODE_LIMIT; attempt++) {
      const code = randomInt(0, ROOM_CODE_LIMIT).toString().padStart(ROOM_CODE_DIGITS, "0");
      if (!this.rooms.has(code)) {
        return code;
      }
    }

    // 步骤2：极端碰撞或接近满号段时，顺序扫描确保只要存在空号就能创建成功。
    for (let value = 0; value < ROOM_CODE_LIMIT; value++) {
      const code = value.toString().padStart(ROOM_CODE_DIGITS, "0");
      if (!this.rooms.has(code)) {
        return code;
      }
    }

    throw new ServiceUnavailableException("房间号已用尽，请稍后再试");
  }

  private initialPlaybackState(now: string): PlaybackState {
    return {
      playing: false,
      positionSeconds: 0,
      playbackRate: 1,
      stateUpdatedAt: now,
      version: 0
    };
  }

  private initialHostStreamState(hostMemberId: string): HostStreamState {
    return {
      streaming: false,
      hostMemberId,
      fileName: null,
      startedAt: null,
      stoppedAt: null,
      version: 0
    };
  }

  private nextPlaybackState(room: StoredRoom, patch: Pick<PlaybackState, "positionSeconds"> & Partial<Pick<PlaybackState, "playing" | "playbackRate">>): PlaybackState {
    return {
      playing: patch.playing ?? room.playbackState.playing,
      positionSeconds: Math.max(0, patch.positionSeconds),
      playbackRate: patch.playbackRate ?? room.playbackState.playbackRate,
      stateUpdatedAt: new Date().toISOString(),
      version: room.playbackState.version + 1
    };
  }

  private isAllowedPlaybackRate(playbackRate: number): boolean {
    return PLAYBACK_RATE_OPTIONS.some((rate) => Math.abs(rate - playbackRate) < 0.001);
  }

  private assertPassword(room: StoredRoom, password?: string): void {
    if (!room.passwordHash) {
      return;
    }
    if (!password || !verifyPassword(password, room.passwordHash)) {
      throw new ForbiddenException("房间密码错误");
    }
  }

  private assertDirectMode(room: StoredRoom): void {
    if (room.watchMode !== "direct") {
      throw new ForbiddenException("房主推流模式不支持网盘选片或服务端播放状态同步");
    }
  }

  private assertHostStreamOwner(room: StoredRoom, memberId: string): void {
    if (room.watchMode !== "host-stream") {
      throw new ForbiddenException("当前房间不是房主推流模式");
    }
    if (room.ownerId !== memberId) {
      throw new ForbiddenException("只有房主可以开始或停止推流");
    }
  }

  private normalizeNickname(nickname: string): string {
    const trimmed = nickname.trim();
    if (!trimmed) {
      throw new BadRequestException("昵称不能为空");
    }
    return trimmed.slice(0, 24);
  }

  private touch(room: StoredRoom): void {
    room.updatedAt = new Date().toISOString();
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [salt, expected] = encoded.split(":");
  if (!salt || !expected) {
    const fallback = createHash("sha256").update(password).digest("hex");
    return fallback === encoded;
  }
  const actual = scryptSync(password, salt, 32);
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}
