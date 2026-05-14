import type { PlaybackState } from "@sync-seat/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPlaybackState, targetPosition } from "./playback-sync";

function createVideo(currentTime: number, playbackRate = 1, paused = false): HTMLVideoElement {
  return {
    currentTime,
    playbackRate,
    paused,
    play: vi.fn(async () => undefined),
    pause: vi.fn()
  } as unknown as HTMLVideoElement;
}

function state(patch: Partial<PlaybackState> = {}): PlaybackState {
  return {
    playing: true,
    positionSeconds: 10,
    playbackRate: 1.5,
    stateUpdatedAt: new Date().toISOString(),
    version: 1,
    lastOperationId: null,
    lastMemberId: null,
    lastAction: null,
    ...patch
  };
}

describe("applyPlaybackState", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("使用服务端发送时间和本地单调时间，避免客户端系统时间偏差", () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-01-01T00:00:10.000Z").getTime());

    const target = targetPosition(
      state({ positionSeconds: 10, playbackRate: 1, stateUpdatedAt: "2026-01-01T00:00:00.000Z" }),
      { serverTimeMs: new Date("2026-01-01T00:00:00.000Z").getTime(), receivedAtMs: 1000 },
      1000
    );

    expect(target).toBe(10);
  });

  it("收到状态后只按本地 performance 增量继续推进", () => {
    const target = targetPosition(
      state({ positionSeconds: 10, playbackRate: 1.5, stateUpdatedAt: "2026-01-01T00:00:00.000Z" }),
      { serverTimeMs: new Date("2026-01-01T00:00:01.000Z").getTime(), receivedAtMs: 100 },
      2100
    );

    expect(target).toBeCloseTo(14.5);
  });

  it("3 秒以内的播放偏差使用基础倍速乘轻微修正", async () => {
    const video = createVideo(9);

    await applyPlaybackState(video, state({ positionSeconds: 10 }));

    expect(video.currentTime).toBe(9);
    expect(video.playbackRate).toBeCloseTo(1.5 * 1.05);
  });

  it("超过 3 秒的播放偏差直接跳转目标时间", async () => {
    const video = createVideo(6);

    await applyPlaybackState(video, state({ positionSeconds: 10 }));

    expect(video.currentTime).toBeCloseTo(10);
    expect(video.playbackRate).toBe(1.5);
  });

  it("暂停状态强制同步时间并暂停播放器", async () => {
    const video = createVideo(9.8, 1.5, false);

    await applyPlaybackState(video, state({ playing: false, positionSeconds: 10 }));

    expect(video.currentTime).toBe(10);
    expect(video.playbackRate).toBe(1.5);
    expect(video.pause).toHaveBeenCalledOnce();
  });

  it("0.5 秒以内的小偏差不调整临时倍速", async () => {
    const video = createVideo(9.7);

    await applyPlaybackState(video, state({ positionSeconds: 10 }));

    expect(video.currentTime).toBe(9.7);
    expect(video.playbackRate).toBe(1.5);
  });
});
