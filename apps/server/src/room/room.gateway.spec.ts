import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomGateway } from "./room.gateway.js";

function createGateway() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const rooms = {
    getOwnerId: vi.fn(() => "owner")
  };
  const realtime = {
    roomName: vi.fn((roomCode: string) => `room:${roomCode}`),
    targetSocketIds: vi.fn(() => ["owner-socket"])
  };
  const gateway = new RoomGateway(rooms as never, realtime as never);
  (gateway as unknown as { server: { to: typeof to } }).server = { to };
  return { gateway, rooms, realtime, to, emit };
}

describe("RoomGateway host stream events", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("广播房主推流播放快照", async () => {
    const { gateway, to, emit } = createGateway();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));

    await gateway.roomEvent({
      type: "host_stream_playback_snapshot",
      roomCode: "abcd",
      memberId: "owner",
      durationSeconds: 120,
      positionSeconds: 30,
      playing: true,
      playbackRate: 1
    });

    expect(to).toHaveBeenCalledWith("room:ABCD");
    expect(emit).toHaveBeenCalledWith("room_event", {
      type: "host_stream_playback_snapshot",
      fromMemberId: "owner",
      serverTimeMs: new Date("2026-05-14T12:00:00.000Z").getTime(),
      durationSeconds: 120,
      positionSeconds: 30,
      playing: true,
      playbackRate: 1,
      updatedAt: "2026-05-14T12:00:00.000Z"
    });
  });

  it("只把观众画质请求转发给房主并保留请求观众", async () => {
    const { gateway, realtime, to, emit } = createGateway();

    await gateway.roomEvent({
      type: "host_stream_quality_request",
      roomCode: "abcd",
      memberId: "viewer-a",
      quality: "smooth"
    });

    expect(realtime.targetSocketIds).toHaveBeenCalledWith("ABCD", "owner");
    expect(to).toHaveBeenCalledWith("owner-socket");
    expect(emit).toHaveBeenCalledWith("room_event", {
      type: "host_stream_quality_command",
      fromMemberId: "viewer-a",
      quality: "smooth"
    });
  });

  it("只把成员观看进度转发给房主", async () => {
    const { gateway, realtime, to, emit } = createGateway();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:05.000Z"));

    await gateway.roomEvent({
      type: "member_watch_progress_report",
      roomCode: "abcd",
      memberId: "viewer-a",
      positionSeconds: 88,
      durationSeconds: 300,
      playing: true
    });

    expect(realtime.targetSocketIds).toHaveBeenCalledWith("ABCD", "owner");
    expect(to).toHaveBeenCalledWith("owner-socket");
    expect(emit).toHaveBeenCalledWith("room_event", {
      type: "member_watch_progress_update",
      fromMemberId: "viewer-a",
      serverTimeMs: new Date("2026-05-14T12:00:05.000Z").getTime(),
      positionSeconds: 88,
      durationSeconds: 300,
      playing: true,
      updatedAt: "2026-05-14T12:00:05.000Z"
    });
  });
});
