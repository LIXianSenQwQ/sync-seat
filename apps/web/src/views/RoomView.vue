<script setup lang="ts">
import { PLAYBACK_RATE_OPTIONS, type ClientRoomEvent, type DriveEntry, type HostControlCommand, type RoomState } from "@sync-seat/shared";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import CustomVideoPlayer from "../components/CustomVideoPlayer.vue";
import MobileTabBar from "../components/MobileTabBar.vue";
import RoomTopBar from "../components/RoomTopBar.vue";
import RoomSidebar from "../components/RoomSidebar.vue";
import VideoPanel from "../components/VideoPanel.vue";
import { api } from "../services/api";
import { HostStreamMesh, type HostStreamQuality } from "../services/host-stream";
import { describeHostStreamRoute, type HostStreamIceDiagnostics } from "../services/ice-diagnostics";
import { useIdentityStore } from "../stores/identity";
import { RoomSocket, type RoomStateSyncClock } from "../services/realtime";
import { resolveVoiceTurnIceServers, VoiceMesh } from "../services/voice";
import type { FunctionSection } from "../components/FunctionNav.vue";

const route = useRoute();
const router = useRouter();
const identityStore = useIdentityStore();

const roomCode = computed(() => String(route.params.roomCode).toUpperCase());
const identity = { memberId: identityStore.memberId, nickname: identityStore.nickname };
const password = ref("");
const room = ref<RoomState | null>(null);
const playbackSyncClock = ref<RoomStateSyncClock | null>(null);
const playbackSyncClockVersion = ref<number | null>(null);
const error = ref("");
const directPlayerRef = ref<InstanceType<typeof CustomVideoPlayer> | null>(null);
const hostPlayerRef = ref<InstanceType<typeof CustomVideoPlayer> | null>(null);
const entries = ref<DriveEntry[]>([]);
const subtitles = ref<DriveEntry[]>([]);
const currentPath = ref("/");
const connected = ref(false);
const socket = new RoomSocket();
const voice = ref<VoiceMesh | null>(null);
const voiceJoined = ref(false);
const muted = ref(false);
const volume = ref(1);
const hostStream = shallowRef<HostStreamMesh | null>(null);
let hostStreamPromise: Promise<HostStreamMesh> | null = null;
const localVideoUrl = ref("");
const localVideoName = ref("");
const remoteMediaStream = ref<MediaStream | null>(null);
const remoteStreamReady = ref(false);
const hostStreamIceState = ref<Record<string, RTCIceConnectionState>>({});
const hostStreamDiagnostics = ref<Record<string, HostStreamIceDiagnostics>>({});
const voiceIceState = ref<Record<string, RTCIceConnectionState>>({});
const hostStreamQuality = ref<HostStreamQuality>("original");
const voiceJoining = ref(false);
const voiceRelayError = ref("");
const activeSection = ref<FunctionSection>("members-voice");
const showMobileDrawer = ref(false);
let roomRefreshTimer: number | null = null;

const hostStreamQualityOptions: { label: string; value: HostStreamQuality }[] = [
  { label: "原画", value: "original" },
  { label: "标准", value: "standard" },
  { label: "流畅", value: "smooth" }
];

const members = computed(() => room.value?.members ?? []);
const currentMember = computed(() => members.value.find((m) => m.memberId === identity.memberId));
const isOwner = computed(() => room.value?.ownerId === identity.memberId);
const isDirectMode = computed(() => room.value?.watchMode === "direct");
const isHostStreamMode = computed(() => room.value?.watchMode === "host-stream");
const directPlaybackSyncClock = computed(() =>
  room.value?.playbackState.version === playbackSyncClockVersion.value ? playbackSyncClock.value : null
);
const hostStreamDiagnosticLabels = computed(() =>
  Object.entries(hostStreamDiagnostics.value).map(([memberId, diagnostics]) => {
    const member = members.value.find((m) => m.memberId === memberId);
    const name = member?.nickname ?? memberId;
    return `${name}: ${describeHostStreamRoute(diagnostics)} (${diagnostics.stage === "relay" ? "TURN 中继" : "IPv6 优先"}，${diagnostics.state})`;
  })
);
const hasTerminalHostStreamError = computed(() =>
  Object.values(hostStreamDiagnostics.value).some((d) => d.stage === "relay" && d.state === "failed")
);
const currentVideoPath = computed(() => room.value?.currentVideo?.filePath ?? null);
const currentSubtitlePath = computed(() => room.value?.currentSubtitle?.filePath ?? null);
const roomStreaming = computed(() => room.value?.hostStreamState?.streaming ?? false);
const hasVideo = computed(() => {
  if (isDirectMode.value) return !!room.value?.currentVideo;
  if (isHostStreamMode.value) return isOwner.value ? !!localVideoUrl.value : !!remoteMediaStream.value;
  return false;
});
const emptyMessage = computed(() => {
  if (isHostStreamMode.value && isOwner.value && !localVideoUrl.value) return "选择本地视频后开始房主推流";
  if (isHostStreamMode.value && !isOwner.value) return "等待房主开始推流…";
  return "选择一个网盘视频开始观影";
});
const topBarTitle = computed(() => {
  if (isHostStreamMode.value) return room.value?.hostStreamState?.fileName || "房主推流";
  return room.value?.currentVideo?.fileName || "等待选片";
});
// === 房间操作 ===
async function join(): Promise<void> {
  error.value = "";
  try {
    room.value = await api.joinRoom(roomCode.value, {
      memberId: identity.memberId,
      nickname: identity.nickname,
      password: password.value || undefined
    });
    connectSocket();
    if (room.value.watchMode === "direct") {
      await loadDirectory("/");
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : "加入房间失败";
  }
}

async function restoreIfMember(): Promise<boolean> {
  try {
    const current = await api.getRoom(roomCode.value);
    const alreadyJoined = current.members.some((m) => m.memberId === identity.memberId);
    if (!alreadyJoined && current.hasPassword) return false;
    room.value = await api.joinRoom(roomCode.value, {
      memberId: identity.memberId,
      nickname: identity.nickname
    });
    connectSocket();
    if (room.value.watchMode === "direct") {
      await loadDirectory("/");
    }
    return true;
  } catch {
    return false;
  }
}

function connectSocket(): void {
  socket.connect(
    roomCode.value, identity.memberId, identity.nickname,
    async (nextRoom, syncClock) => {
      playbackSyncClock.value = syncClock;
      playbackSyncClockVersion.value = nextRoom.playbackState.version;
      room.value = nextRoom;
      connected.value = true;
      await nextTick();
      if (nextRoom.currentVideo) {
        subtitles.value = await api.listSubtitles(nextRoom.currentVideo.filePath).catch(() => []);
      }
      if (nextRoom.watchMode === "host-stream") {
        if (isOwner.value) await hostStream.value?.publishToMembers(nextRoom.members);
      }
    },
    (event) => { void voice.value?.handleSignal(event.fromMemberId, event.signalType, event.payload); },
    (event) => {
      void ensureHostStream().then(
        (mesh) => mesh.handleSignal(event.fromMemberId, event.signalType, event.payload),
        (err) => console.error("[HostStream] ensureHostStream 初始化失败:", err)
      );
    },
    (event) => { applyHostControl(event); },
    (reason) => {
      error.value = reason;
      room.value = null;
      voice.value?.leave(); voice.value = null;
      voiceJoined.value = false; voiceRelayError.value = ""; voiceIceState.value = {};
      hostStream.value?.stop(); remoteMediaStream.value = null;
      remoteStreamReady.value = false; hostStreamDiagnostics.value = {}; hostStreamIceState.value = {};
    },
    (message) => { error.value = message; }
  );
}

async function refreshRoomState(): Promise<void> {
  if (!room.value) return;
  try { room.value = await api.getRoom(roomCode.value); } catch { /* 兜底刷新 */ }
}

async function loadDirectory(path: string): Promise<void> {
  currentPath.value = path;
  entries.value = await api.listDrive(path);
}

function goUp(): void {
  const parts = currentPath.value.split("/").filter(Boolean).slice(0, -1).join("/");
  loadDirectory("/" + parts);
}

function send(event: ClientRoomEvent): void { socket.send(event); }
function loadVideo(path: string): void {
  send({ type: "load_video", roomCode: roomCode.value, memberId: identity.memberId, filePath: path });
}
function selectSubtitle(path: string | null): void {
  send({ type: "select_subtitle", roomCode: roomCode.value, memberId: identity.memberId, filePath: path });
}

function createOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function handleDirectPlaybackIntent(intent: {
  action: "play" | "pause" | "seek" | "playback_rate_change" | "buffer_pause";
  positionSeconds: number; playing: boolean; playbackRate: number; baseVersion: number;
}): void {
  send({
    type: "set_playback", roomCode: roomCode.value, memberId: identity.memberId,
    operationId: createOperationId(), baseVersion: intent.baseVersion,
    action: intent.action, positionSeconds: intent.positionSeconds,
    playing: intent.playing, playbackRate: intent.playbackRate
  });
}

async function ensureHostStream(): Promise<HostStreamMesh> {
  if (hostStream.value) return hostStream.value;
  if (!hostStreamPromise) {
    hostStreamPromise = (async () => {
      const iceServers = await api.getIceServers();
      hostStream.value = new HostStreamMesh(
        iceServers, identity.memberId, "",
        (targetMemberId, type, payload) => {
          send({
            type: type === "offer" ? "host_stream_offer" : type === "answer" ? "host_stream_answer" : "host_stream_ice_candidate",
            roomCode: roomCode.value, memberId: identity.memberId, targetMemberId,
            ...(type === "ice_candidate" ? { candidate: payload } : { description: payload })
          } as ClientRoomEvent);
        },
        (stream) => { remoteMediaStream.value = stream; remoteStreamReady.value = true; },
        (memberId, state) => {
          hostStreamIceState.value = { ...hostStreamIceState.value, [memberId]: state };
        },
        (memberId, diagnostics) => {
          hostStreamDiagnostics.value = { ...hostStreamDiagnostics.value, [memberId]: diagnostics };
        },
        hostStreamQuality.value
      );
      return hostStream.value;
    })();
  }
  return hostStreamPromise;
}

function selectLocalVideo(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (localVideoUrl.value) URL.revokeObjectURL(localVideoUrl.value);
  localVideoName.value = file.name;
  localVideoUrl.value = URL.createObjectURL(file);
}

async function startHostStream(): Promise<void> {
  const video = hostPlayerRef.value?.getVideoElement();
  if (!video || !localVideoName.value || !room.value) return;
  try {
    if (video.readyState < 1) {
      await new Promise<void>((resolve) => {
        video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      });
    }
    await video.play();
    const mesh = await ensureHostStream();
    mesh.captureFromVideo(video);
    send({ type: "host_stream_start", roomCode: roomCode.value, memberId: identity.memberId, fileName: localVideoName.value });
    await mesh.publishToMembers(room.value.members);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "开始推流失败";
  }
}

function stopHostStream(): void {
  hostStream.value?.stop(); hostStream.value = null; hostStreamPromise = null;
  remoteMediaStream.value = null; remoteStreamReady.value = false;
  hostStreamDiagnostics.value = {}; hostStreamIceState.value = {};
  send({ type: "host_stream_stop", roomCode: roomCode.value, memberId: identity.memberId });
}

function requestHostControl(command: HostControlCommand): void {
  send({ type: "host_control_request", roomCode: roomCode.value, memberId: identity.memberId, ...command });
}

function applyHostControl(command: HostControlCommand): void {
  const video = hostPlayerRef.value?.getVideoElement();
  if (!isOwner.value || !video) return;
  if (typeof command.positionSeconds === "number") video.currentTime = Math.max(0, command.positionSeconds);
  if (typeof command.playbackRate === "number") video.playbackRate = command.playbackRate;
  if (command.action === "play") void video.play().catch(() => undefined);
  if (command.action === "pause") video.pause();
}

async function joinVoice(): Promise<void> {
  if (voiceJoining.value || voiceJoined.value) return;
  let localStream: MediaStream | null = null;
  voiceJoining.value = true; error.value = ""; voiceRelayError.value = "";
  try {
    const iceServers = await api.getVoiceIceServers();
    if (resolveVoiceTurnIceServers(iceServers).length === 0) {
      throw new Error("语音已配置为强制 TURN 中继，但当前没有可用 TURN 服务。请联系部署者配置真实的 WEBRTC_TURN_URLS、WEBRTC_TURN_USERNAME 和 TURN_AUTH_SECRET。");
    }
    localStream = await requestMicrophoneStream();
    voice.value = new VoiceMesh(iceServers, identity.memberId, (targetMemberId, type, payload) => {
      send({
        type: type === "offer" ? "voice_offer" : type === "answer" ? "voice_answer" : "voice_ice_candidate",
        roomCode: roomCode.value, memberId: identity.memberId, targetMemberId,
        ...(type === "ice_candidate" ? { candidate: payload } : { description: payload })
      } as ClientRoomEvent);
    }, (memberId, state) => {
      voiceIceState.value = { ...voiceIceState.value, [memberId]: state };
    });
    await voice.value.join(members.value, localStream);
    localStream = null;
    voice.value.setVolume(volume.value);
    voiceJoined.value = true;
    send({ type: "voice_join", roomCode: roomCode.value, memberId: identity.memberId });
  } catch (err) {
    localStream?.getTracks().forEach((t) => t.stop());
    voice.value?.leave(); voice.value = null;
    error.value = normalizeVoiceError(err);
  } finally {
    voiceJoining.value = false;
  }
}

async function requestMicrophoneStream(): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前页面不是安全上下文，浏览器不会弹出麦克风权限。请使用 localhost、127.0.0.1 或 HTTPS 访问页面。");
  }
  return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
}

function normalizeVoiceError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "麦克风权限被拒绝，请在浏览器地址栏权限设置中允许麦克风后重试";
    if (err.name === "NotFoundError") return "未检测到可用麦克风，请连接或启用麦克风后重试";
    if (err.name === "NotReadableError") return "麦克风正被其他程序占用，请关闭占用后重试";
  }
  return err instanceof Error ? err.message : "加入语音失败";
}

function leaveVoice(): void {
  voice.value?.leave(); voice.value = null;
  voiceJoined.value = false; voiceJoining.value = false;
  muted.value = false; voiceRelayError.value = ""; voiceIceState.value = {};
  send({ type: "voice_leave", roomCode: roomCode.value, memberId: identity.memberId });
}

function toggleMute(): void {
  muted.value = !muted.value;
  voice.value?.setMuted(muted.value);
  send({ type: "voice_mute", roomCode: roomCode.value, memberId: identity.memberId, muted: muted.value });
}

function goHome(): void {
  router.push("/");
}

watch(volume, (v) => voice.value?.setVolume(v));
watch(hostStreamQuality, (q) => { void hostStream.value?.setQuality(q); });

onMounted(async () => {
  const restored = await restoreIfMember();
  const queryVideo = String(route.query.video ?? "");
  if (restored && queryVideo) loadVideo(queryVideo);
  if (!restored && queryVideo) { await join(); loadVideo(queryVideo); }
  roomRefreshTimer = window.setInterval(() => { void refreshRoomState(); }, 5000);
});

onBeforeUnmount(() => {
  if (roomRefreshTimer) window.clearInterval(roomRefreshTimer);
  socket.close();
  voice.value?.leave(); voiceRelayError.value = ""; voiceIceState.value = {};
  hostStream.value?.stop(); hostStream.value = null; hostStreamPromise = null;
  remoteMediaStream.value = null; remoteStreamReady.value = false;
  hostStreamDiagnostics.value = {}; hostStreamIceState.value = {};
  if (localVideoUrl.value) URL.revokeObjectURL(localVideoUrl.value);
});
</script>

<template>
  <div class="flex flex-col h-full bg-surface-main">
    <!-- 顶部状态栏 -->
    <RoomTopBar
      :room-code="roomCode"
      :title="topBarTitle"
      :connected="connected"
      @back="goHome"
    />

    <!-- 主体布局：主内容区 + 侧边栏 -->
    <div class="flex flex-1 min-h-0 relative">
      <!-- 主内容区 - 视频播放器 -->
      <div class="flex-1 min-w-0 p-4 lg:pr-0">
        <!-- 密码门控 -->
        <div v-if="!room" class="flex items-center justify-center h-full">
          <div class="w-full max-w-sm bg-surface-elevated rounded-modal p-6 shadow-2xl">
            <h2 class="text-heading text-text-primary mb-4">加入房间</h2>
            <label class="block mb-4">
              <span class="text-body-sm text-text-secondary block mb-1.5">房间密码</span>
              <input
                v-model="password"
                type="password"
                placeholder="无密码可留空"
                class="w-full px-3 py-2.5 rounded-button bg-surface-deepest border border-white/10 text-text-primary outline-none focus:border-brand-500 transition-colors"
              />
            </label>
            <button
              class="w-full py-2.5 rounded-button bg-brand-500 text-white font-medium transition-colors hover:bg-brand-600"
              @click="join"
            >
              加入
            </button>
            <p v-if="error" class="mt-3 text-body-sm text-status-busy">{{ error }}</p>
          </div>
        </div>

        <!-- 已加入：播放器 + 动态面板 -->
        <div v-else class="flex flex-col h-full gap-3 min-h-0">
          <VideoPanel
            :is-empty="!hasVideo"
            :empty-message="emptyMessage"
          >
            <!-- 直链模式播放器 -->
            <CustomVideoPlayer
              v-if="isDirectMode && room.currentVideo"
              ref="directPlayerRef"
              sync-mode
              :src="room.currentVideo.playUrl"
              :playback-state="room.playbackState"
              :playback-sync-clock="directPlaybackSyncClock"
              :playback-rate-options="PLAYBACK_RATE_OPTIONS"
              :subtitle-track="room.currentSubtitle ? { src: room.currentSubtitle.trackUrl, label: '房间字幕', srclang: 'zh' } : null"
              @set-playback="handleDirectPlaybackIntent"
            />

            <!-- 房主推流模式：房主 -->
            <CustomVideoPlayer
              v-else-if="isHostStreamMode && isOwner && localVideoUrl"
              ref="hostPlayerRef"
              :src="localVideoUrl"
              :playback-rate-options="PLAYBACK_RATE_OPTIONS"
            />

            <!-- 房主推流模式：观众 -->
            <CustomVideoPlayer
              v-else-if="isHostStreamMode"
              src=""
              autoplay
              :media-stream="remoteMediaStream"
              :show-progress="false"
              :show-time="false"
              :show-playback-rates="false"
              :show-step-buttons="false"
            />
          </VideoPanel>

          <!-- 错误提示 -->
          <p v-if="error" class="text-body-sm text-status-busy px-1">{{ error }}</p>
        </div>
      </div>

      <!-- 第二栏侧边栏 - 桌面端固定，移动端抽屉 -->
      <Transition name="drawer">
        <RoomSidebar
          v-if="room"
          class="hidden lg:flex"
          :class="{ '!flex fixed inset-y-0 right-0 z-40 w-72 shadow-2xl': showMobileDrawer }"
          :active-section="activeSection"
          :entries="entries"
          :current-path="currentPath"
          :current-video-path="currentVideoPath"
          :room="room"
          :is-direct-mode="isDirectMode"
          :is-host-stream-mode="isHostStreamMode"
          :is-owner="isOwner"
          :voice-joined="voiceJoined"
          :voice-joining="voiceJoining"
          :muted="muted"
          :volume="volume"
          :voice-relay-error="voiceRelayError"
          :host-stream-quality="hostStreamQuality"
          :host-stream-quality-options="hostStreamQualityOptions"
          :remote-stream-ready="remoteStreamReady"
          :host-stream-diagnostic-labels="hostStreamDiagnosticLabels"
          :has-terminal-host-stream-error="hasTerminalHostStreamError"
          :subtitles="subtitles"
          :current-subtitle-path="currentSubtitlePath"
          :local-video-url="localVideoUrl"
          :room-streaming="roomStreaming"
          :members="members"
          :current-member="currentMember"
          @select-section="activeSection = $event; showMobileDrawer = false"
          @navigate="loadDirectory"
          @load-video="loadVideo"
          @go-up="goUp"
          @join-voice="joinVoice"
          @leave-voice="leaveVoice"
          @toggle-mute="toggleMute"
          @update:volume="volume = $event"
          @select-local-video="selectLocalVideo"
          @update:host-stream-quality="hostStreamQuality = $event as HostStreamQuality"
          @start-host-stream="startHostStream"
          @stop-host-stream="stopHostStream"
          @request-host-control="requestHostControl"
          @select-subtitle="selectSubtitle"
        />
      </Transition>

      <!-- 移动端抽屉遮罩 -->
      <Transition name="fade">
        <div
          v-if="showMobileDrawer"
          class="fixed inset-0 z-30 bg-black/50 lg:hidden"
          @click="showMobileDrawer = false"
        />
      </Transition>
    </div>

    <!-- 移动端底部 TabBar -->
    <MobileTabBar
      v-if="room"
      :active-section="activeSection"
      @select="(section: FunctionSection) => { activeSection = section; showMobileDrawer = true }"
    />
  </div>
</template>

<style scoped>
.drawer-enter-active {
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.drawer-leave-active {
  transition: transform 0.2s ease-in;
}
.drawer-enter-from,
.drawer-leave-to {
  transform: translateX(100%);
}

.fade-enter-active {
  transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.fade-leave-active {
  transition: opacity 0.2s ease-in;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
