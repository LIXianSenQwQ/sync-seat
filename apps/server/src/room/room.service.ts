import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { CurrentSubtitle, HostStreamState, PlaybackState, RoomState, WatchMode } from "@sync-seat/shared";
import { AlistService } from "../drive/alist.service.js";
import { SubtitleService } from "../drive/subtitle.service.js";
import { clonePublicRoom, type JoinResult, type StoredRoom } from "./room.types.js";

const MAX_MEMBERS = 3;
const OWNER_GRACE_MS = 60_000;
const EMPTY_ROOM_TTL_MS = 60_000;

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
    return { room: clonePublicRoom(room), reconnected: false };
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
    if (room.watchMode === "host-stream" && room.ownerId === memberId) {
      this.rooms.delete(room.roomCode);
      return clonePublicRoom({
        ...room,
        members: room.members.map((item) => (item.memberId === memberId ? member : item)),
        emptySince: now,
        updatedAt: now
      });
    }
    if (room.ownerId === memberId) {
      room.ownerDisconnectedAt = now;
    }
    if (!room.members.some((item) => item.connected)) {
      room.emptySince = now;
    }
    this.touch(room);
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
      // 步骤1：房主离线超过保留窗口后，转让给最早在线成员。
      if (room.ownerDisconnectedAt && nowMs - Date.parse(room.ownerDisconnectedAt) >= OWNER_GRACE_MS) {
        const nextOwnerId = room.memberOrder.find((id) => room.members.some((m) => m.memberId === id && m.connected));
        if (nextOwnerId) {
          room.ownerId = nextOwnerId;
          room.ownerDisconnectedAt = null;
          this.touch(room);
        }
      }

      // 步骤2：空房超过 TTL 后释放内存状态。
      if (room.emptySince && nowMs - Date.parse(room.emptySince) >= EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(roomCode);
        removed.push(roomCode);
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
    room.currentVideo = video;
    room.currentSubtitle = null;
    room.playbackState = this.nextPlaybackState(room, {
      playing: false,
      positionSeconds: 0,
      playbackRate: 1
    });
    this.touch(room);
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
    room.playbackState = this.nextPlaybackState(room, patch);
    this.touch(room);
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
    return clonePublicRoom(room);
  }

  getCurrentSubtitle(roomCode: string): CurrentSubtitle | null {
    return this.getStoredRoom(roomCode).currentSubtitle;
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
    let code = "";
    do {
      code = randomBytes(4).toString("base64url").replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase();
    } while (code.length < 6 || this.rooms.has(code));
    return code;
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
