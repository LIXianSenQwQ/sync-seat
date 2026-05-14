import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { CurrentVideo } from "@sync-seat/shared";
import { RoomService } from "./room.service.js";

const video: CurrentVideo = {
  filePath: "/Movies/demo.mp4",
  fileName: "demo.mp4",
  playUrl: "https://alist.test/d/Movies/demo.mp4"
};

function createService(): RoomService {
  return new RoomService(
    {
      getVideo: vi.fn(async () => video),
      resolveFileUrl: vi.fn(async () => "https://alist.test/d/Movies/demo.mp4"),
      openFileStream: vi.fn(async () => new Response(null, { status: 206 }))
    } as never,
    {
      buildCurrentSubtitle: vi.fn((filePath: string, roomCode: string) => ({
        filePath,
        fileName: filePath.split("/").pop() ?? filePath,
        format: "srt",
        trackUrl: `/api/rooms/${roomCode}/subtitle.vtt`
      }))
    } as never
  );
}

function playbackOperation(patch: Partial<{ operationId: string; memberId: string; action: "play" | "pause" | "seek" | "playback_rate_change"; baseVersion: number }> = {}) {
  return {
    operationId: "op-1",
    memberId: "m1",
    action: "play" as const,
    baseVersion: 0,
    ...patch
  };
}

describe("RoomService", () => {
  it("创建空房间并允许用正确密码加入", () => {
    const service = createService();
    const room = service.createRoom("m1", "清羽", "secret");

    expect(room.watchMode).toBe("direct");
    expect(room.hasPassword).toBe(true);
    expect(room.roomCode).toMatch(/^\d{4}$/);
    expect(room.hostStreamState).toBeNull();
    expect(() => service.joinRoom(room.roomCode, "m2", "朋友", "wrong")).toThrow(ForbiddenException);
    const joined = service.joinRoom(room.roomCode, "m2", "朋友", "secret").room;
    expect(joined.members).toHaveLength(2);
  });

  it("无密码房间对前端公开无需密码标记", () => {
    const service = createService();
    const room = service.createRoom("m1", "清羽");

    expect(room.hasPassword).toBe(false);
    expect(service.getRoom(room.roomCode).hasPassword).toBe(false);
  });

  it("创建房主推流房间时初始化推流状态", () => {
    const service = createService();
    const room = service.createRoom("m1", "清羽", undefined, "host-stream");

    expect(room.watchMode).toBe("host-stream");
    expect(room.hostStreamState).toMatchObject({
      streaming: false,
      hostMemberId: "m1",
      fileName: null,
      version: 0
    });
  });

  it("限制单房间最多 3 人", () => {
    const service = createService();
    const room = service.createRoom("m1", "A");
    service.joinRoom(room.roomCode, "m2", "B");
    service.joinRoom(room.roomCode, "m3", "C");

    expect(() => service.joinRoom(room.roomCode, "m4", "D")).toThrow(ForbiddenException);
  });

  it("相同 memberId 重连时恢复原成员而不是新增成员", () => {
    const service = createService();
    const room = service.createRoom("m1", "A", "secret");
    service.leaveRoom(room.roomCode, "m1");
    const joined = service.joinRoom(room.roomCode, "m1", "A2");

    expect(joined.reconnected).toBe(true);
    expect(joined.room.members).toHaveLength(1);
    expect(joined.room.members[0]?.connected).toBe(true);
  });

  it("实时通道重连会恢复已有成员并取消空房释放计时", () => {
    const service = createService();
    const room = service.createRoom("m1", "A");
    service.leaveRoom(room.roomCode, "m1");

    const reconnected = service.reconnectMember(room.roomCode, "m1", "A2");

    expect(reconnected.emptySince).toBeNull();
    expect(reconnected.members).toHaveLength(1);
    expect(reconnected.members[0]).toMatchObject({ memberId: "m1", nickname: "A2", connected: true });
    expect(service.sweep(Date.parse(reconnected.updatedAt) + 60_000)).toEqual([]);
  });

  it("房主离线 60 秒后按进入顺序自动转让", () => {
    const service = createService();
    const room = service.createRoom("m1", "A");
    service.joinRoom(room.roomCode, "m2", "B");
    const left = service.leaveRoom(room.roomCode, "m1");
    const disconnectedAt = Date.parse(left.updatedAt);

    service.sweep(disconnectedAt + 60_000);

    expect(service.getRoom(room.roomCode).ownerId).toBe("m2");
  });

  it("普通成员离线后仍保留在公开成员列表中", () => {
    const service = createService();
    const room = service.createRoom("m1", "A");
    service.joinRoom(room.roomCode, "m2", "B");

    const left = service.leaveRoom(room.roomCode, "m2");

    expect(left.members).toHaveLength(2);
    expect(left.members.find((member) => member.memberId === "m2")).toMatchObject({
      nickname: "B",
      connected: false,
      voiceJoined: false,
      muted: false
    });
  });

  it("房主推流房间在房主短暂断线时保留房间并停止推流", () => {
    const service = createService();
    const room = service.createRoom("m1", "A", undefined, "host-stream");
    service.joinRoom(room.roomCode, "m2", "B");
    service.startHostStream(room.roomCode, "m1", "local.mp4");

    const left = service.leaveRoom(room.roomCode, "m1");

    expect(left.members.find((member) => member.memberId === "m1")?.connected).toBe(false);
    expect(left.hostStreamState).toMatchObject({ streaming: false, fileName: "local.mp4", version: 2 });
    expect(service.getRoom(room.roomCode).roomCode).toBe(room.roomCode);
  });

  it("房主推流房间在房主断线超过保留窗口后关闭", () => {
    const service = createService();
    const room = service.createRoom("m1", "A", undefined, "host-stream");
    service.joinRoom(room.roomCode, "m2", "B");

    const left = service.leaveRoom(room.roomCode, "m1");
    const removed = service.sweep(Date.parse(left.updatedAt) + 60_000);

    expect(removed).toEqual([room.roomCode]);
    expect(() => service.getRoom(room.roomCode)).toThrow(NotFoundException);
  });

  it("空房间 60 秒后释放", () => {
    const service = createService();
    const room = service.createRoom("m1", "A");
    const left = service.leaveRoom(room.roomCode, "m1");
    const removed = service.sweep(Date.parse(left.updatedAt) + 60_000);

    expect(removed).toEqual([room.roomCode]);
  });

  it("播放状态按服务端接收顺序递增版本号，后到为准", () => {
    const service = createService();
    const room = service.createRoom("m1", "A");
    const first = service.updatePlayback(room.roomCode, { playing: true, playbackRate: 1, positionSeconds: 10 }, playbackOperation({ operationId: "op-1", action: "play" }));
    const second = service.updatePlayback(room.roomCode, { playing: false, playbackRate: 1, positionSeconds: 20 }, playbackOperation({ operationId: "op-2", action: "pause", baseVersion: 1 }));

    expect(first.playbackState.version).toBe(1);
    expect(second.playbackState.version).toBe(2);
    expect(second.playbackState.playing).toBe(false);
    expect(second.playbackState.positionSeconds).toBe(20);
    expect(second.playbackState).toMatchObject({
      lastOperationId: "op-2",
      lastMemberId: "m1",
      lastAction: "pause"
    });
  });

  it("只允许固定房间倍速并递增播放版本", () => {
    const service = createService();
    const room = service.createRoom("m1", "A");
    const updated = service.updatePlayback(
      room.roomCode,
      { playing: false, playbackRate: 1.5, positionSeconds: 12 },
      playbackOperation({ action: "playback_rate_change" })
    );

    expect(updated.playbackState.playbackRate).toBe(1.5);
    expect(updated.playbackState.positionSeconds).toBe(12);
    expect(updated.playbackState.version).toBe(1);
    expect(() =>
      service.updatePlayback(
        room.roomCode,
        { playing: false, playbackRate: 1.4, positionSeconds: 13 },
        playbackOperation({ action: "playback_rate_change" })
      )
    ).toThrow(BadRequestException);
    expect(service.getRoom(room.roomCode).playbackState).toMatchObject({
      playbackRate: 1.5,
      positionSeconds: 12,
      version: 1
    });
  });

  it("加载视频会清空字幕并重置播放位置", async () => {
    const service = createService();
    const room = service.createRoom("m1", "A");
    service.selectSubtitle(room.roomCode, "/Movies/demo.srt");
    service.updatePlayback(room.roomCode, { playing: true, playbackRate: 2, positionSeconds: 30 }, playbackOperation({ action: "playback_rate_change" }));
    const updated = await service.loadVideo(room.roomCode, "/Movies/demo.mp4");

    expect(updated.currentVideo).toEqual({
      ...video,
      playUrl: `/api/rooms/${room.roomCode}/video?path=${encodeURIComponent(video.filePath)}`
    });
    expect(updated.currentSubtitle).toBeNull();
    expect(updated.playbackState.positionSeconds).toBe(0);
    expect(updated.playbackState.playbackRate).toBe(1);
  });

  it("只为房间当前视频解析 302 跳转地址", async () => {
    const service = createService();
    const room = service.createRoom("m1", "A");

    await expect(service.resolveCurrentVideoUrl(room.roomCode)).rejects.toThrow(NotFoundException);
    await service.loadVideo(room.roomCode, "/Movies/demo.mp4");

    await expect(service.resolveCurrentVideoUrl(room.roomCode)).resolves.toBe("https://alist.test/d/Movies/demo.mp4");
  });

  it("只为房间当前视频打开代理读取流", async () => {
    const service = createService();
    const room = service.createRoom("m1", "A");

    await expect(service.openCurrentVideoStream(room.roomCode, "bytes=0-99")).rejects.toThrow(NotFoundException);
    await service.loadVideo(room.roomCode, "/Movies/demo.mp4");

    const response = await service.openCurrentVideoStream(room.roomCode, "bytes=0-99");
    expect(response.status).toBe(206);
  });

  it("房主推流模式拒绝网盘选片和字幕状态污染", async () => {
    const service = createService();
    const room = service.createRoom("m1", "A", undefined, "host-stream");

    await expect(service.loadVideo(room.roomCode, "/Movies/demo.mp4")).rejects.toThrow(ForbiddenException);
    expect(() => service.selectSubtitle(room.roomCode, "/Movies/demo.srt")).toThrow(ForbiddenException);
  });

  it("房主可以开始和停止本地推流", () => {
    const service = createService();
    const room = service.createRoom("m1", "A", undefined, "host-stream");

    const started = service.startHostStream(room.roomCode, "m1", "local.mp4");
    const stopped = service.stopHostStream(room.roomCode, "m1");

    expect(started.hostStreamState).toMatchObject({ streaming: true, fileName: "local.mp4", version: 1 });
    expect(stopped.hostStreamState).toMatchObject({ streaming: false, fileName: "local.mp4", version: 2 });
  });

  it("非房主不能开始房主推流", () => {
    const service = createService();
    const room = service.createRoom("m1", "A", undefined, "host-stream");
    service.joinRoom(room.roomCode, "m2", "B");

    expect(() => service.startHostStream(room.roomCode, "m2", "local.mp4")).toThrow(ForbiddenException);
  });
});
