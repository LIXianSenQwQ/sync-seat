<script setup lang="ts">
import { IconArrowsMaximize, IconArrowsMinimize, IconPlayerPause, IconPlayerPlay, IconRotate360, IconVolume, IconVolume2, IconVolumeOff } from "@tabler/icons-vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { PLAYBACK_RATE_OPTIONS, type PlaybackAction, type PlaybackState } from "@sync-seat/shared";
import { applyPlaybackState, targetPosition, type PlaybackSyncClock } from "../services/playback-sync";

interface SubtitleTrack {
  src: string;
  label: string;
  srclang: string;
}

interface SetPlaybackIntent {
  action: PlaybackAction;
  positionSeconds: number;
  playing: boolean;
  playbackRate: number;
  baseVersion: number;
}

const props = withDefaults(
  defineProps<{
    src: string;
    mediaStream?: MediaStream | null;
    playbackState?: PlaybackState | null;
    playbackSyncClock?: PlaybackSyncClock | null;
    subtitleTrack?: SubtitleTrack | null;
    syncMode?: boolean;
    playbackRateOptions?: readonly number[];
    showProgress?: boolean;
    showTime?: boolean;
    showVolume?: boolean;
    showPlaybackRates?: boolean;
    showStepButtons?: boolean;
    autoplay?: boolean;
  }>(),
  {
    mediaStream: null,
    playbackState: null,
    playbackSyncClock: null,
    subtitleTrack: null,
    syncMode: false,
    playbackRateOptions: () => PLAYBACK_RATE_OPTIONS,
    showProgress: true,
    showTime: true,
    showVolume: true,
    showPlaybackRates: true,
    showStepButtons: true,
    autoplay: false
  }
);

const emit = defineEmits<{
  "set-playback": [intent: SetPlaybackIntent];
}>();

const VOLUME_KEY = "sync-seat:player-volume";
const MUTED_KEY = "sync-seat:player-muted";

const rootRef = ref<HTMLElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);
const progressRef = ref<HTMLElement | null>(null);
const duration = ref(0);
const currentTime = ref(0);
const dragPosition = ref(0);
const pendingSeekTarget = ref<number | null>(null);
const dragging = ref(false);
const waiting = ref(false);
const mediaError = ref("");
const playing = ref(false);
const muted = ref(false);
const volume = ref(1);
const controlsVisible = ref(true);
const isNativeFullscreen = ref(false);
const isPseudoFullscreen = ref(false);
const remotePlayBlocked = ref(false);
let wasPlayingBeforeDrag = false;
let rafId = 0;
let hideControlsTimer: number | null = null;
let deferredRemoteState: PlaybackState | null = null;
let lastAppliedVersion = -1;
const PSEUDO_FULLSCREEN_BODY_CLASS = "custom-player-pseudo-fullscreen-open";

const safeDuration = computed(() => (Number.isFinite(duration.value) && duration.value > 0 ? duration.value : 0));
const displayTime = computed(() => {
  if (dragging.value) return dragPosition.value;
  if (pendingSeekTarget.value !== null) return pendingSeekTarget.value;
  return currentTime.value;
});
const progressPercent = computed(() => (safeDuration.value ? (displayTime.value / safeDuration.value) * 100 : 0));
const bufferedPercent = computed(() => {
  const video = videoRef.value;
  if (!video || !safeDuration.value || video.buffered.length === 0) return 0;
  let end = 0;
  for (let index = 0; index < video.buffered.length; index += 1) {
    end = Math.max(end, video.buffered.end(index));
  }
  return Math.min(100, (end / safeDuration.value) * 100);
});
const sliderValue = computed(() => Math.round(displayTime.value));
const rateValue = computed(() => props.playbackState?.playbackRate ?? videoRef.value?.playbackRate ?? 1);
const showLoading = computed(() => waiting.value || pendingSeekTarget.value !== null);
const isFullscreen = computed(() => isNativeFullscreen.value || isPseudoFullscreen.value);

function getVideoElement(): HTMLVideoElement | null {
  return videoRef.value;
}

defineExpose({ getVideoElement });

function clampPosition(value: number): number {
  if (!safeDuration.value) return Math.max(0, value);
  return Math.min(Math.max(0, value), safeDuration.value);
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "00:00";
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function readStoredVolume(): void {
  const storedVolume = Number(window.localStorage.getItem(VOLUME_KEY));
  if (Number.isFinite(storedVolume)) {
    volume.value = Math.min(1, Math.max(0, storedVolume));
  }
  muted.value = window.localStorage.getItem(MUTED_KEY) === "true";
}

function persistVolume(): void {
  window.localStorage.setItem(VOLUME_KEY, String(volume.value));
  window.localStorage.setItem(MUTED_KEY, String(muted.value));
}

function emitPlayback(action: PlaybackAction, positionSeconds: number, nextPlaying: boolean, playbackRate = rateValue.value): void {
  if (!props.syncMode || !props.playbackState) return;
  emit("set-playback", {
    action,
    positionSeconds: clampPosition(positionSeconds),
    playing: nextPlaying,
    playbackRate,
    baseVersion: props.playbackState.version
  });
}

function authoritativeIntentPosition(action: PlaybackAction, fallbackPosition: number): number {
  if (!props.playbackState || action === "seek") {
    return fallbackPosition;
  }
  // 步骤1：播放/暂停/倍速变化不表达新的进度位置，优先沿用房间权威状态，避免本地残留偏移回写。
  return targetPosition(props.playbackState, props.playbackSyncClock);
}

async function userTogglePlayback(): Promise<void> {
  const video = videoRef.value;
  if (!video) return;
  showControls();
  remotePlayBlocked.value = false;
  if (playing.value || props.playbackState?.playing) {
    video.pause();
    playing.value = false;
    emitPlayback("pause", authoritativeIntentPosition("pause", video.currentTime), false);
    return;
  }
  try {
    await video.play();
    playing.value = true;
    emitPlayback("play", authoritativeIntentPosition("play", video.currentTime), true);
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      remotePlayBlocked.value = true;
    }
  }
}

function isInteractiveControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, input, select, textarea, a, [role='slider']"));
}

function handlePlayerClick(event: MouseEvent): void {
  showControls();
  if (isInteractiveControl(event.target)) return;
  void userTogglePlayback();
}

function userChangeRate(nextRate: number): void {
  const video = videoRef.value;
  if (!video) return;
  video.playbackRate = nextRate;
  emitPlayback(
    "playback_rate_change",
    authoritativeIntentPosition("playback_rate_change", video.currentTime),
    playing.value || Boolean(props.playbackState?.playing),
    nextRate
  );
}

function pointerToPosition(event: PointerEvent): number {
  const track = progressRef.value;
  if (!track || !safeDuration.value) return 0;
  const rect = track.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  return ratio * safeDuration.value;
}

function startDrag(event: PointerEvent): void {
  const video = videoRef.value;
  if (!video || !props.showProgress || !safeDuration.value) return;
  event.preventDefault();
  progressRef.value?.setPointerCapture(event.pointerId);
  wasPlayingBeforeDrag = playing.value || Boolean(props.playbackState?.playing);
  dragging.value = true;
  dragPosition.value = pointerToPosition(event);
  showControls();
}

function moveDrag(event: PointerEvent): void {
  if (!dragging.value) return;
  event.preventDefault();
  dragPosition.value = pointerToPosition(event);
}

async function finishDrag(event: PointerEvent): Promise<void> {
  const video = videoRef.value;
  if (!video || !dragging.value) return;
  event.preventDefault();
  progressRef.value?.releasePointerCapture(event.pointerId);
  dragPosition.value = pointerToPosition(event);
  const target = clampPosition(dragPosition.value);
  dragging.value = false;
  pendingSeekTarget.value = target;
  waiting.value = true;
  video.currentTime = target;
  if (wasPlayingBeforeDrag) {
    await video.play().catch(() => undefined);
  } else {
    video.pause();
  }
  emitPlayback("seek", target, wasPlayingBeforeDrag);
  wasPlayingBeforeDrag = false;
  if (deferredRemoteState) {
    const next = deferredRemoteState;
    deferredRemoteState = null;
    applyRemoteState(next);
  }
}

function cancelDrag(): void {
  dragging.value = false;
  wasPlayingBeforeDrag = false;
}

function stepBy(seconds: number): void {
  const video = videoRef.value;
  if (!video || !props.showProgress || !safeDuration.value) return;
  const target = clampPosition(displayTime.value + seconds);
  pendingSeekTarget.value = target;
  waiting.value = true;
  video.currentTime = target;
  emitPlayback("seek", target, playing.value || Boolean(props.playbackState?.playing));
}

function handlePlayerKeydown(event: KeyboardEvent): void {
  if (event.code === "Space") {
    event.preventDefault();
    void userTogglePlayback();
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    stepBy(-5);
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    stepBy(5);
  }
  if (event.key.toLowerCase() === "m") {
    event.preventDefault();
    muted.value = !muted.value;
  }
  if (event.key.toLowerCase() === "f") {
    event.preventDefault();
    void toggleFullscreen();
  }
}

function onLoadedMetadata(): void {
  const video = videoRef.value;
  if (!video) return;
  duration.value = Number.isFinite(video.duration) ? video.duration : 0;
  currentTime.value = video.currentTime;
  mediaError.value = "";
}

function onRuntimeUpdate(): void {
  const video = videoRef.value;
  if (!video) return;
  currentTime.value = video.currentTime;
  duration.value = Number.isFinite(video.duration) ? video.duration : duration.value;
  playing.value = !video.paused;
  if (pendingSeekTarget.value !== null && Math.abs(video.currentTime - pendingSeekTarget.value) < 0.5) {
    pendingSeekTarget.value = null;
  }
}

function onRuntimeWaiting(): void {
  waiting.value = true;
  showControls();
}

function onRuntimeReady(): void {
  waiting.value = false;
  onRuntimeUpdate();
}

function onRuntimeError(): void {
  const video = videoRef.value;
  const code = video?.error?.code;
  mediaError.value = code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? "当前浏览器不支持此视频格式" : "视频加载失败，请检查资源地址或网络状态";
  waiting.value = false;
  showControls();
}

function syncLocalVolume(): void {
  const video = videoRef.value;
  if (!video) return;
  video.volume = volume.value;
  video.muted = muted.value;
  persistVolume();
}

function syncMediaStream(): void {
  const video = videoRef.value;
  if (!video) return;
  if (props.mediaStream) {
    video.srcObject = props.mediaStream;
    return;
  }
  if (video.srcObject) {
    video.srcObject = null;
  }
}

async function applyRemoteState(state: PlaybackState): Promise<void> {
  const video = videoRef.value;
  if (!video) return;
  if (dragging.value) {
    deferredRemoteState = state;
    return;
  }
  if (state.playing && !props.playbackSyncClock) {
    return;
  }
  lastAppliedVersion = state.version;
  remotePlayBlocked.value = false;
  const target = targetPosition(state, props.playbackSyncClock);
  if (!state.playing || Math.abs(target - video.currentTime) > 3) {
    pendingSeekTarget.value = target;
    waiting.value = true;
  }
  try {
    await applyPlaybackState(video, state, props.playbackSyncClock);
    playing.value = state.playing;
  } catch (err) {
    if (state.playing && err instanceof DOMException && err.name === "NotAllowedError") {
      remotePlayBlocked.value = true;
      showControls();
      return;
    }
    mediaError.value = err instanceof Error ? err.message : "应用房间播放状态失败";
  }
}

function resumeRemotePlayback(): void {
  if (props.playbackState) {
    void applyRemoteState(props.playbackState);
  }
}

function showControls(): void {
  controlsVisible.value = true;
  if (hideControlsTimer) {
    window.clearTimeout(hideControlsTimer);
    hideControlsTimer = null;
  }
  if (!playing.value || dragging.value || waiting.value || mediaError.value || remotePlayBlocked.value) return;
  hideControlsTimer = window.setTimeout(() => {
    controlsVisible.value = false;
  }, 2500);
}

function enterPseudoFullscreen(): void {
  const root = rootRef.value;
  if (!root) return;
  isPseudoFullscreen.value = true;
  document.body.classList.add(PSEUDO_FULLSCREEN_BODY_CLASS);
  showControls();
}

function exitPseudoFullscreen(): void {
  isPseudoFullscreen.value = false;
  document.body.classList.remove(PSEUDO_FULLSCREEN_BODY_CLASS);
}

async function toggleFullscreen(): Promise<void> {
  const root = rootRef.value;
  if (!root) return;
  if (isPseudoFullscreen.value) {
    exitPseudoFullscreen();
    return;
  }
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  if (root.requestFullscreen) {
    try {
      await root.requestFullscreen();
    } catch {
      enterPseudoFullscreen();
    }
    return;
  }
  enterPseudoFullscreen();
}

function handleFullscreenChange(): void {
  isNativeFullscreen.value = Boolean(document.fullscreenElement);
}

function frame(): void {
  onRuntimeUpdate();
  rafId = window.requestAnimationFrame(frame);
}

watch(volume, syncLocalVolume);
watch(muted, syncLocalVolume);
watch(
  () => props.playbackState,
  (state) => {
    if (!props.syncMode || !state || state.version <= lastAppliedVersion) return;
    void applyRemoteState(state);
  },
  { immediate: true }
);
watch(
  () => props.src,
  () => {
    pendingSeekTarget.value = null;
    mediaError.value = "";
    waiting.value = Boolean(props.src);
    lastAppliedVersion = -1;
  }
);
watch(
  () => props.mediaStream,
  () => {
    syncMediaStream();
    if (props.autoplay) {
      void videoRef.value?.play().catch(() => undefined);
    }
  }
);

onMounted(() => {
  readStoredVolume();
  syncLocalVolume();
  syncMediaStream();
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  rafId = window.requestAnimationFrame(frame);
  void nextTick(() => {
    if (props.autoplay) {
      void videoRef.value?.play().catch(() => undefined);
    }
  });
});

onBeforeUnmount(() => {
  if (rafId) window.cancelAnimationFrame(rafId);
  if (hideControlsTimer) window.clearTimeout(hideControlsTimer);
  document.removeEventListener("fullscreenchange", handleFullscreenChange);
  exitPseudoFullscreen();
});
</script>

<template>
  <div
    ref="rootRef"
    class="custom-player"
    :class="{ 'controls-hidden': !controlsVisible, loading: showLoading, 'mobile-pseudo-fullscreen': isPseudoFullscreen }"
    tabindex="0"
    @keydown="handlePlayerKeydown"
    @pointermove="showControls"
    @click="handlePlayerClick"
  >
    <video
      ref="videoRef"
      class="custom-player-video"
      :src="src"
      playsinline
      webkit-playsinline
      x5-playsinline
      x5-video-player-type="h5"
      x5-video-player-fullscreen="false"
      controlslist="nodownload noplaybackrate noremoteplayback"
      disablepictureinpicture
      disableremoteplayback
      @loadedmetadata="onLoadedMetadata"
      @durationchange="onLoadedMetadata"
      @timeupdate="onRuntimeUpdate"
      @play="onRuntimeUpdate"
      @pause="onRuntimeUpdate"
      @waiting="onRuntimeWaiting"
      @stalled="onRuntimeWaiting"
      @seeking="onRuntimeWaiting"
      @seeked="onRuntimeReady"
      @canplay="onRuntimeReady"
      @playing="onRuntimeReady"
      @error="onRuntimeError"
    >
      <track
        v-if="subtitleTrack"
        kind="subtitles"
        :src="subtitleTrack.src"
        :label="subtitleTrack.label"
        :srclang="subtitleTrack.srclang"
        default
      />
    </video>

    <div v-if="showLoading && !mediaError" class="player-center-state">正在缓冲…</div>
    <div v-if="mediaError" class="player-center-state error-state">
      <strong>{{ mediaError }}</strong>
    </div>
    <div v-if="remotePlayBlocked" class="player-center-state">
      <button class="player-text-button" type="button" @click="resumeRemotePlayback">继续同步播放</button>
      <span>浏览器已拦截自动播放，点击后继续跟随房间进度</span>
    </div>

    <div class="player-controls" @pointermove.stop="showControls" @click.stop>
      <div
        v-if="showProgress"
        ref="progressRef"
        class="player-progress"
        role="slider"
        tabindex="0"
        :aria-valuemin="0"
        :aria-valuemax="Math.max(0, Math.round(safeDuration))"
        :aria-valuenow="sliderValue"
        aria-label="播放进度"
        @pointerdown="startDrag"
        @pointermove="moveDrag"
        @pointerup="finishDrag"
        @pointercancel="cancelDrag"
      >
        <div class="player-progress-track"></div>
        <div class="player-progress-buffered" :style="{ width: `${bufferedPercent}%` }"></div>
        <div class="player-progress-played" :style="{ width: `${progressPercent}%` }"></div>
        <div class="player-progress-thumb" :style="{ left: `${progressPercent}%` }"></div>
      </div>

      <div class="player-control-row">
        <button class="player-icon-button" type="button" :title="playing ? '暂停' : '播放'" @click="userTogglePlayback">
          <IconPlayerPause v-if="playing" :size="20" />
          <IconPlayerPlay v-else :size="20" />
        </button>
        <span v-if="showTime" class="player-time">{{ formatTime(displayTime) }} / {{ formatTime(safeDuration) }}</span>

        <div class="player-spacer"></div>

        <button v-if="showVolume" class="player-icon-button" type="button" :title="muted ? '取消静音' : '静音'" @click="muted = !muted">
          <IconVolumeOff v-if="muted || volume === 0" :size="20" />
          <IconVolume v-else-if="volume < 0.6" :size="20" />
          <IconVolume2 v-else :size="20" />
        </button>
        <input v-if="showVolume" v-model.number="volume" class="player-volume" type="range" min="0" max="1" step="0.05" aria-label="音量" />

        <div v-if="showPlaybackRates" class="player-rate-group" aria-label="播放倍速">
          <button
            v-for="rate in playbackRateOptions"
            :key="rate"
            class="player-rate-button"
            :class="{ active: Math.abs(rateValue - rate) < 0.001 }"
            type="button"
            @click="userChangeRate(rate)"
          >
            {{ rate }}x
          </button>
        </div>

        <button v-if="showStepButtons" class="player-icon-button" type="button" title="回退 5 秒" @click="stepBy(-5)">
          <IconRotate360 :size="18" />
        </button>
        <button class="player-icon-button" type="button" :title="isFullscreen ? '退出全屏' : '全屏'" @click="toggleFullscreen">
          <IconArrowsMinimize v-if="isFullscreen" :size="20" />
          <IconArrowsMaximize v-else :size="20" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.custom-player {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 72vh;
  overflow: hidden;
  background: #050607;
  color: #f8fbff;
  outline: none;
}

.custom-player-video {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 72vh;
  background: #050607;
  object-fit: contain;
  pointer-events: none;
}

.custom-player-video::-webkit-media-controls,
.custom-player-video::-webkit-media-controls-panel,
.custom-player-video::-webkit-media-controls-play-button,
.custom-player-video::-webkit-media-controls-start-playback-button {
  display: none !important;
  opacity: 0 !important;
  pointer-events: none !important;
}

:global(body.custom-player-pseudo-fullscreen-open) {
  overflow: hidden;
}

.custom-player.mobile-pseudo-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 9999;
  width: 100vw;
  height: 100dvh;
  min-height: 100dvh;
  border-radius: 0;
}

.custom-player.mobile-pseudo-fullscreen .custom-player-video {
  height: 100%;
  min-height: 100dvh;
}

.player-center-state {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 10px;
  padding: 24px;
  background: rgba(5, 6, 7, 0.45);
  color: #d9e5ed;
  text-align: center;
  pointer-events: none;
}

.player-center-state button {
  pointer-events: auto;
}

.error-state {
  background: rgba(40, 12, 12, 0.72);
  color: #ffcec8;
}

.player-text-button,
.player-icon-button,
.player-rate-button {
  border: 0;
  border-radius: 8px;
  color: #f8fbff;
}

.player-text-button {
  min-height: 42px;
  background: #2d9c9f;
  padding: 0 16px;
}

.player-controls {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  gap: 10px;
  padding: 18px;
  background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.78));
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.controls-hidden .player-controls {
  opacity: 0;
  transform: translateY(16px);
  pointer-events: none;
}

.player-progress {
  position: relative;
  height: 22px;
  cursor: pointer;
  touch-action: none;
}

.player-progress-track,
.player-progress-buffered,
.player-progress-played {
  position: absolute;
  top: 9px;
  left: 0;
  height: 4px;
  border-radius: 999px;
}

.player-progress-track {
  width: 100%;
  background: rgba(255, 255, 255, 0.18);
}

.player-progress-buffered {
  background: rgba(255, 255, 255, 0.32);
}

.player-progress-played {
  background: #68c6d0;
}

.player-progress-thumb {
  position: absolute;
  top: 4px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #f8fbff;
  box-shadow: 0 0 0 4px rgba(104, 198, 208, 0.22);
  transform: translateX(-50%);
}

.player-control-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.player-icon-button {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  width: 38px;
  height: 38px;
  background: rgba(255, 255, 255, 0.12);
}

.player-time {
  min-width: 118px;
  color: #d9e5ed;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.player-spacer {
  flex: 1 1 auto;
}

.player-volume {
  width: 96px;
  padding: 0;
}

.player-rate-group {
  display: flex;
  gap: 6px;
}

.player-rate-button {
  min-width: 44px;
  height: 34px;
  background: rgba(255, 255, 255, 0.1);
  font-size: 12px;
  font-weight: 700;
}

.player-rate-button.active {
  background: #2d9c9f;
}

@media (max-width: 720px) {
  .player-controls {
    padding: 12px;
  }

  .player-control-row {
    flex-wrap: wrap;
  }

  .player-spacer {
    display: none;
  }

  .player-rate-group {
    order: 3;
    width: 100%;
  }

  .player-rate-button {
    flex: 1;
  }
}
</style>
