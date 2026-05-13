import type { PlaybackState } from "@sync-seat/shared";

/**
 * 依据服务端权威状态计算当前目标播放时间。
 *
 * @author 清羽
 */
export function targetPosition(state: PlaybackState, nowMs = Date.now()): number {
  if (!state.playing) {
    return state.positionSeconds;
  }
  const elapsed = Math.max(0, nowMs - Date.parse(state.stateUpdatedAt)) / 1000;
  return state.positionSeconds + elapsed * state.playbackRate;
}

/**
 * 将本地播放器校准到服务端状态。
 *
 * @param video HTML5 video 元素。
 * @param state 服务端权威播放状态。
 * @returns 播放动作的 Promise，用于让调用方处理浏览器自动播放拦截。
 */
export function applyPlaybackState(video: HTMLVideoElement, state: PlaybackState): Promise<void> {
  const target = targetPosition(state);
  const drift = target - video.currentTime;
  video.playbackRate = state.playbackRate;

  // 步骤1：小漂移不处理，避免频繁修正造成观感抖动。
  if (Math.abs(drift) >= 1) {
    video.currentTime = target;
  } else if (Math.abs(drift) >= 0.5 && state.playing) {
    video.playbackRate = state.playbackRate * (drift > 0 ? 1.05 : 0.95);
  }

  // 步骤2：播放/暂停以服务端状态为准。
  if (state.playing && video.paused) {
    return video.play().then(() => undefined);
  }
  if (!state.playing && !video.paused) {
    video.pause();
  }
  return Promise.resolve();
}
