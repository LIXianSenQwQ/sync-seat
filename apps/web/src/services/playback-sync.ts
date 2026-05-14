import type { PlaybackState } from "@sync-seat/shared";

/**
 * 客户端收到服务端状态时建立的单调时钟上下文。
 *
 * @author 清羽
 */
export interface PlaybackSyncClock {
  serverTimeMs: number;
  receivedAtMs: number;
}

/**
 * 依据服务端权威状态计算当前目标播放时间。
 *
 * @author 清羽
 */
export function targetPosition(state: PlaybackState, clock?: PlaybackSyncClock | number | null, nowMs = performance.now()): number {
  if (!state.playing) {
    return state.positionSeconds;
  }
  const stateUpdatedAtMs = Date.parse(state.stateUpdatedAt);
  const elapsedMs = typeof clock === "number"
    ? Math.max(0, clock - stateUpdatedAtMs)
    : clock
    ? Math.max(0, clock.serverTimeMs - stateUpdatedAtMs + nowMs - clock.receivedAtMs)
    : Math.max(0, Date.now() - stateUpdatedAtMs);
  const elapsed = elapsedMs / 1000;
  return state.positionSeconds + elapsed * state.playbackRate;
}

/**
 * 将本地播放器校准到服务端状态。
 *
 * @param video HTML5 video 元素。
 * @param state 服务端权威播放状态。
 * @param clock 收到房间状态时的服务端时间和本地单调时间。
 * @returns 播放动作的 Promise，用于让调用方处理浏览器自动播放拦截。
 */
export function applyPlaybackState(video: HTMLVideoElement, state: PlaybackState, clock?: PlaybackSyncClock | null): Promise<void> {
  const target = targetPosition(state, clock);
  const drift = target - video.currentTime;
  const absDrift = Math.abs(drift);
  let nextPlaybackRate = state.playbackRate;

  // 步骤1：暂停时强制对齐所有成员；播放时 3 秒以上才直接 seek，优先保证观影画面顺滑。
  if (!state.playing) {
    video.currentTime = target;
  } else if (absDrift > 3) {
    video.currentTime = target;
  } else if (absDrift >= 0.5) {
    nextPlaybackRate = state.playbackRate * (drift > 0 ? 1.05 : 0.95);
  }

  // 步骤2：轻微追赶只基于房间基础倍速临时调整，不改变服务端权威倍速。
  if (Math.abs(video.playbackRate - nextPlaybackRate) >= 0.001) {
    video.playbackRate = nextPlaybackRate;
  }

  // 步骤3：播放/暂停以服务端状态为准。
  if (state.playing && video.paused) {
    return video.play().then(() => undefined);
  }
  if (!state.playing && !video.paused) {
    video.pause();
  }
  return Promise.resolve();
}
