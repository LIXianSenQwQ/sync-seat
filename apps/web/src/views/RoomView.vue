<script setup lang="ts">
import type { ClientRoomEvent, DriveEntry, HostControlCommand, RoomState } from "@sync-seat/shared";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../services/api";
import { HostStreamMesh, type HostStreamQuality } from "../services/host-stream";
import { describeHostStreamRoute, type HostStreamIceDiagnostics } from "../services/ice-diagnostics";
import { getIdentity } from "../services/identity";
import { applyPlaybackState } from "../services/playback-sync";
import { RoomSocket } from "../services/realtime";
import { VoiceMesh } from "../services/voice";

const route = useRoute();
const router = useRouter();
const roomCode = computed(() => String(route.params.roomCode).toUpperCase());
const identity = getIdentity();
const password = ref("");
const room = ref<RoomState | null>(null);
const error = ref("");
const videoRef = ref<HTMLVideoElement | null>(null);
const hostVideoRef = ref<HTMLVideoElement | null>(null);
const remoteStreamVideoRef = ref<HTMLVideoElement | null>(null);
const entries = ref<DriveEntry[]>([]);
const subtitles = ref<DriveEntry[]>([]);
const currentPath = ref("/");
const connected = ref(false);
const socket = new RoomSocket();
const voice = ref<VoiceMesh | null>(null);
const voiceJoined = ref(false);
const muted = ref(false);
const volume = ref(1);
const applyingRemote = ref(false);
const hostStream = shallowRef<HostStreamMesh | null>(null);
/** 防止 ensureHostStream 并发调用时创建多个 HostStreamMesh 实例 */
let hostStreamPromise: Promise<HostStreamMesh> | null = null;
/** 服务端返回的客户端真实局域网 IP，用于修复 Chrome mDNS 隐藏 */
let clientIp = "";
let clientIpPromise: Promise<string> | null = null;
const localVideoUrl = ref("");
const localVideoName = ref("");
const remoteStreamReady = ref(false);
const hostStreamIceState = ref<Record<string, RTCIceConnectionState>>({});
const hostStreamDiagnostics = ref<Record<string, HostStreamIceDiagnostics>>({});
const voiceIceState = ref<Record<string, RTCIceConnectionState>>({});
const hostStreamQuality = ref<HostStreamQuality>("original");
const voiceJoining = ref(false);
let calibrationTimer: number | null = null;

const hostStreamQualityOptions: { label: string; value: HostStreamQuality }[] = [
  { label: "原画", value: "original" },
  { label: "标准", value: "standard" },
  { label: "流畅", value: "smooth" }
];
const members = computed(() => room.value?.members ?? []);
const currentMember = computed(() => members.value.find((member) => member.memberId === identity.memberId));
const isOwner = computed(() => room.value?.ownerId === identity.memberId);
const isDirectMode = computed(() => room.value?.watchMode === "direct");
const isHostStreamMode = computed(() => room.value?.watchMode === "host-stream");
const hostStreamDiagnosticLabels = computed(() => Object.entries(hostStreamDiagnostics.value).map(([memberId, diagnostics]) => {
  const member = members.value.find((item) => item.memberId === memberId);
  const name = member?.nickname ?? memberId;
  const restartText = diagnostics.restarted ? "，已重试 ICE" : "";
  return `${name}: ${describeHostStreamRoute(diagnostics)} (${diagnostics.state}${restartText})`;
}));

async function join(): Promise<void> {
  error.value = "";
  try {
    room.value = await api.joinRoom(roomCode.value, {
      memberId: identity.memberId,
      nickname: identity.nickname,
      password: password.value || undefined
    });
    connectSocket();
    void ensureClientIp();
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
    const alreadyJoined = current.members.some((member) => member.memberId === identity.memberId);
    if (!alreadyJoined && current.hasPassword) {
      return false;
    }
    room.value = await api.joinRoom(roomCode.value, {
      memberId: identity.memberId,
      nickname: identity.nickname
    });
    connectSocket();
    void ensureClientIp();
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
    roomCode.value,
    identity.memberId,
    async (nextRoom) => {
      const previousVersion = room.value?.playbackState.version ?? -1;
      room.value = nextRoom;
      connected.value = true;
      await nextTick();
      if (nextRoom.watchMode === "direct" && videoRef.value && nextRoom.playbackState.version >= previousVersion) {
        applyingRemote.value = true;
        applyPlaybackState(videoRef.value, nextRoom.playbackState);
        window.setTimeout(() => {
          applyingRemote.value = false;
        }, 120);
      }
      if (nextRoom.currentVideo) {
        subtitles.value = await api.listSubtitles(nextRoom.currentVideo.filePath).catch(() => []);
      }
      if (nextRoom.watchMode === "host-stream" && isOwner.value) {
        await hostStream.value?.publishToMembers(nextRoom.members);
      }
    },
    (event) => {
      void voice.value?.handleSignal(event.fromMemberId, event.signalType, event.payload);
    },
    (event) => {
      void ensureHostStream().then(
        (mesh) => mesh.handleSignal(event.fromMemberId, event.signalType, event.payload),
        (err) => console.error("[HostStream] ensureHostStream 初始化失败:", err)
      );
    },
    (event) => {
      applyHostControl(event);
    },
    (reason) => {
      error.value = reason;
      room.value = null;
      hostStream.value?.stop();
      hostStreamDiagnostics.value = {};
      hostStreamIceState.value = {};
    },
    (message) => {
      error.value = message;
    }
  );
}

async function loadDirectory(path: string): Promise<void> {
  currentPath.value = path;
  entries.value = await api.listDrive(path);
}

function send(event: ClientRoomEvent): void {
  socket.send(event);
}

function loadVideo(path: string): void {
  send({ type: "load_video", roomCode: roomCode.value, memberId: identity.memberId, filePath: path });
}

function selectSubtitle(path: string | null): void {
  send({ type: "select_subtitle", roomCode: roomCode.value, memberId: identity.memberId, filePath: path });
}

function onPlay(): void {
  if (applyingRemote.value || !videoRef.value) return;
  send({ type: "play", roomCode: roomCode.value, memberId: identity.memberId, positionSeconds: videoRef.value.currentTime });
}

function onPause(): void {
  if (applyingRemote.value || !videoRef.value) return;
  send({ type: "pause", roomCode: roomCode.value, memberId: identity.memberId, positionSeconds: videoRef.value.currentTime });
}

function onSeeked(): void {
  if (applyingRemote.value || !videoRef.value) return;
  send({ type: "seek", roomCode: roomCode.value, memberId: identity.memberId, positionSeconds: videoRef.value.currentTime });
}

function onRateChange(): void {
  if (applyingRemote.value || !videoRef.value) return;
  send({
    type: "playback_rate_change",
    roomCode: roomCode.value,
    memberId: identity.memberId,
    playbackRate: videoRef.value.playbackRate,
    positionSeconds: videoRef.value.currentTime
  });
}

async function ensureHostStream(): Promise<HostStreamMesh> {
  if (hostStream.value) return hostStream.value;
  // 防止并发信令到达时创建多个 HostStreamMesh 实例导致 ICE candidates 分发到错误实例
  if (!hostStreamPromise) {
    hostStreamPromise = (async () => {
      const [iceServers, localIp] = await Promise.all([api.getIceServers(), ensureClientIp()]);
      console.log(`[HostStream] ICE 服务器配置已获取，共 ${iceServers.length} 台`);
      hostStream.value = new HostStreamMesh(
        iceServers,
        identity.memberId,
        localIp,
        (targetMemberId, type, payload) => {
          send({
            type: type === "offer" ? "host_stream_offer" : type === "answer" ? "host_stream_answer" : "host_stream_ice_candidate",
            roomCode: roomCode.value,
            memberId: identity.memberId,
            targetMemberId,
            ...(type === "ice_candidate" ? { candidate: payload } : { description: payload })
          } as ClientRoomEvent);
        },
        async (stream) => {
          console.log(`[HostStream] 远端媒体流已就绪，stream id=${stream.id}`);
          remoteStreamReady.value = true;
          await nextTick();
          if (remoteStreamVideoRef.value) {
            remoteStreamVideoRef.value.srcObject = stream;
            await remoteStreamVideoRef.value.play().catch(() => undefined);
          }
        },
        (memberId, state) => {
          hostStreamIceState.value = { ...hostStreamIceState.value, [memberId]: state };
          // 连接失败时给出明确提示
          if (state === "failed" || state === "disconnected") {
            console.warn(`[HostStream] 与 ${memberId} 的 ICE 连接异常 (state: ${state})，请检查 NAT 类型、STUN 可达性、安全上下文或配置 TURN 中继`);
          }
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

async function ensureClientIp(): Promise<string> {
  if (clientIp) return clientIp;
  if (!clientIpPromise) {
    clientIpPromise = api.getClientIp()
      .then(({ ip }) => {
        clientIp = ip;
        console.log(`[HostStream] 客户端局域网 IP: ${ip}`);
        return ip;
      })
      .catch((err) => {
        console.warn("[HostStream] 获取客户端局域网 IP 失败，跳过 mDNS 候选修复:", err);
        return "";
      })
      .finally(() => {
        clientIpPromise = null;
      });
  }
  return clientIpPromise;
}

function selectLocalVideo(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (localVideoUrl.value) {
    URL.revokeObjectURL(localVideoUrl.value);
  }
  localVideoName.value = file.name;
  localVideoUrl.value = URL.createObjectURL(file);
}

async function startHostStream(): Promise<void> {
  if (!hostVideoRef.value || !localVideoName.value || !room.value) return;
  try {
    const video = hostVideoRef.value;
    // 等待视频元数据加载完成，确保 captureStream 能获取音视频轨道
    if (video.readyState < 1) {
      await new Promise<void>((resolve) => {
        video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      });
    }
    // 先播放，让浏览器开始解码渲染，再捕获流，确保流中有活跃轨道
    await video.play();
    const mesh = await ensureHostStream();
    const capturedStream = mesh.captureFromVideo(video);
    console.log(`[HostStream] 已从视频采集媒体流，tracks=${capturedStream.getTracks().length}`);
    send({ type: "host_stream_start", roomCode: roomCode.value, memberId: identity.memberId, fileName: localVideoName.value });
    await mesh.publishToMembers(room.value.members);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "开始推流失败";
  }
}

function stopHostStream(): void {
  hostStream.value?.stop();
  hostStream.value = null;
  hostStreamPromise = null;
  hostStreamDiagnostics.value = {};
  hostStreamIceState.value = {};
  send({ type: "host_stream_stop", roomCode: roomCode.value, memberId: identity.memberId });
}

function requestHostControl(command: HostControlCommand): void {
  send({
    type: "host_control_request",
    roomCode: roomCode.value,
    memberId: identity.memberId,
    ...command
  });
}

function applyHostControl(command: HostControlCommand): void {
  if (!isOwner.value || !hostVideoRef.value) return;
  if (typeof command.positionSeconds === "number") {
    hostVideoRef.value.currentTime = Math.max(0, command.positionSeconds);
  }
  if (typeof command.playbackRate === "number") {
    hostVideoRef.value.playbackRate = command.playbackRate;
  }
  if (command.action === "play") {
    void hostVideoRef.value.play().catch(() => undefined);
  }
  if (command.action === "pause") {
    hostVideoRef.value.pause();
  }
}

async function joinVoice(): Promise<void> {
  if (voiceJoining.value || voiceJoined.value) return;
  let localStream: MediaStream | null = null;
  voiceJoining.value = true;
  error.value = "";
  try {
    localStream = await requestMicrophoneStream();
    const iceServers = await api.getIceServers();
    voice.value = new VoiceMesh(iceServers, identity.memberId, (targetMemberId, type, payload) => {
      send({
        type: type === "offer" ? "voice_offer" : type === "answer" ? "voice_answer" : "voice_ice_candidate",
        roomCode: roomCode.value,
        memberId: identity.memberId,
        targetMemberId,
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
    localStream?.getTracks().forEach((track) => track.stop());
    voice.value?.leave();
    voice.value = null;
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
    if (err.name === "NotAllowedError") {
      return "麦克风权限被拒绝，请在浏览器地址栏权限设置中允许麦克风后重试";
    }
    if (err.name === "NotFoundError") {
      return "未检测到可用麦克风，请连接或启用麦克风后重试";
    }
    if (err.name === "NotReadableError") {
      return "麦克风正被其他程序占用，请关闭占用后重试";
    }
  }
  return err instanceof Error ? err.message : "加入语音失败";
}

function leaveVoice(): void {
  voice.value?.leave();
  voice.value = null;
  voiceJoined.value = false;
  voiceJoining.value = false;
  muted.value = false;
  send({ type: "voice_leave", roomCode: roomCode.value, memberId: identity.memberId });
}

function toggleMute(): void {
  muted.value = !muted.value;
  voice.value?.setMuted(muted.value);
  send({ type: "voice_mute", roomCode: roomCode.value, memberId: identity.memberId, muted: muted.value });
}

watch(volume, (value) => voice.value?.setVolume(value));
watch(hostStreamQuality, (quality) => {
  void hostStream.value?.setQuality(quality);
});

onMounted(async () => {
  const restored = await restoreIfMember();
  if (restored && route.query.video) {
    loadVideo(String(route.query.video));
  }
  if (!restored && route.query.video) {
    await join();
    loadVideo(String(route.query.video));
  }
  calibrationTimer = window.setInterval(() => {
    if (videoRef.value && room.value) {
      applyPlaybackState(videoRef.value, room.value.playbackState);
    }
  }, 5000);
});

onBeforeUnmount(() => {
  if (calibrationTimer) window.clearInterval(calibrationTimer);
  socket.close();
  voice.value?.leave();
  hostStream.value?.stop();
  hostStream.value = null;
  hostStreamPromise = null;
  hostStreamDiagnostics.value = {};
  hostStreamIceState.value = {};
  if (localVideoUrl.value) {
    URL.revokeObjectURL(localVideoUrl.value);
  }
});
</script>

<template>
  <main class="room-shell">
    <header class="room-topbar">
      <button class="icon-button" title="返回首页" @click="router.push('/')">←</button>
      <div>
        <p class="eyebrow">房间 {{ roomCode }}</p>
        <h1>{{ room?.watchMode === 'host-stream' ? (room.hostStreamState?.fileName || '房主推流') : (room?.currentVideo?.fileName || '等待选片') }}</h1>
      </div>
      <span class="status-pill" :class="{ online: connected }">{{ connected ? '已连接' : '未连接' }}</span>
    </header>

    <section v-if="!room" class="join-card card">
      <h2>加入房间</h2>
      <label class="field">
        <span>房间密码</span>
        <input v-model="password" type="password" placeholder="无密码可留空" />
      </label>
      <button class="primary" @click="join">加入</button>
      <p v-if="error" class="error">{{ error }}</p>
    </section>

    <section v-else class="watch-layout">
      <section class="player-panel">
        <video
          v-if="isDirectMode && room.currentVideo"
          ref="videoRef"
          class="video-player"
          controls
          :src="room.currentVideo.playUrl"
          @play="onPlay"
          @pause="onPause"
          @seeked="onSeeked"
          @ratechange="onRateChange"
        >
          <track
            v-if="room.currentSubtitle"
            kind="subtitles"
            srclang="zh"
            label="房间字幕"
            default
            :src="room.currentSubtitle.trackUrl"
          />
        </video>

        <div v-else-if="isHostStreamMode && isOwner" class="host-player">
          <video ref="hostVideoRef" class="video-player" controls :src="localVideoUrl" />
          <div v-if="!localVideoUrl" class="empty-player overlay-empty">
            <span>选择本地视频后开始房主推流</span>
          </div>
        </div>

        <video v-else-if="isHostStreamMode" ref="remoteStreamVideoRef" class="video-player" controls autoplay playsinline />

        <div v-else class="empty-player">
          <span>选择一个网盘视频开始观影</span>
        </div>
      </section>

      <aside class="room-side">
        <section class="card compact">
          <h2>成员</h2>
          <div v-for="member in members" :key="member.memberId" class="member-row">
            <span>{{ member.nickname }}</span>
            <small>{{ member.memberId === room.ownerId ? '房主' : '成员' }} · {{ member.connected ? '在线' : '离线' }}</small>
            <small v-if="member.voiceJoined">{{ member.muted ? '已静音' : '语音中' }}</small>
          </div>
        </section>

        <section class="card compact">
          <h2>语音</h2>
          <button v-if="!voiceJoined" class="primary full" :disabled="voiceJoining" @click="joinVoice">
            {{ voiceJoining ? '正在加入…' : '加入语音' }}
          </button>
          <template v-else>
            <button class="ghost full" @click="toggleMute">{{ muted ? '取消静音' : '静音' }}</button>
            <button class="danger full" @click="leaveVoice">退出语音</button>
          </template>
          <label class="field">
            <span>语音总音量</span>
            <input v-model.number="volume" type="range" min="0" max="1" step="0.05" />
          </label>
          <small>当前身份：{{ currentMember?.nickname }}</small>
        </section>

        <section v-if="isDirectMode" class="card compact">
          <h2>选片</h2>
          <div class="path-row">
            <span>{{ currentPath }}</span>
            <button class="ghost" :disabled="currentPath === '/'" @click="loadDirectory('/' + currentPath.split('/').filter(Boolean).slice(0, -1).join('/'))">上一级</button>
          </div>
          <div class="mini-list">
            <button v-for="entry in entries" :key="entry.path" class="mini-row" @click="entry.type === 'directory' ? loadDirectory(entry.path) : entry.type === 'video' ? loadVideo(entry.path) : undefined">
              <span>{{ entry.type === 'directory' ? '目录' : entry.type === 'video' ? '视频' : entry.type === 'subtitle' ? '字幕' : '文件' }}</span>
              <strong>{{ entry.name }}</strong>
            </button>
          </div>
        </section>

        <section v-if="isDirectMode" class="card compact">
          <h2>字幕</h2>
          <button class="ghost full" :disabled="!room.currentSubtitle" @click="selectSubtitle(null)">清除字幕</button>
          <button v-for="subtitle in subtitles" :key="subtitle.path" class="mini-row" @click="selectSubtitle(subtitle.path)">
            <span>{{ room.currentSubtitle?.filePath === subtitle.path ? '当前' : '字幕' }}</span>
            <strong>{{ subtitle.name }}</strong>
          </button>
        </section>

        <section v-if="isHostStreamMode" class="card compact">
          <h2>房主推流</h2>
          <template v-if="isOwner">
            <label class="field">
              <span>本地视频</span>
              <input type="file" accept=".mp4,.webm,.mov,.m3u8,video/mp4,video/webm,video/quicktime,application/vnd.apple.mpegurl" @change="selectLocalVideo" />
            </label>
            <div class="field">
              <span>清晰度</span>
              <div class="mode-toggle quality-toggle">
                <button
                  v-for="option in hostStreamQualityOptions"
                  :key="option.value"
                  type="button"
                  :class="{ active: hostStreamQuality === option.value }"
                  @click="hostStreamQuality = option.value"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
            <button class="primary full" :disabled="!localVideoUrl" @click="startHostStream">开始推流</button>
            <button class="danger full" :disabled="!room.hostStreamState?.streaming" @click="stopHostStream">停止推流</button>
          </template>
          <template v-else>
            <template v-if="room.hostStreamState?.streaming">
              <p v-if="remoteStreamReady" class="side-note">正在接收房主推流</p>
              <p v-else class="side-note">
                等待房主媒体连接…
                <span v-if="Object.values(hostStreamIceState).length" class="ice-state">
                  ICE: {{ Object.values(hostStreamIceState).join(', ') }}
                </span>
              </p>
              <p v-if="hostStreamDiagnosticLabels.length" class="side-note ice-diagnostics">
                {{ hostStreamDiagnosticLabels.join('；') }}
              </p>
              <p v-if="Object.values(hostStreamIceState).some(s => s === 'failed' || s === 'disconnected')" class="error">
                P2P 连接异常，请检查双方 NAT 类型、STUN 是否可达，以及公网访问是否使用 HTTPS；复杂 NAT 下需要配置 TURN 中继服务器
              </p>
            </template>
            <p v-else class="side-note">房主尚未开始推流</p>
            <button class="ghost full" @click="requestHostControl({ action: 'play' })">请求播放</button>
            <button class="ghost full" @click="requestHostControl({ action: 'pause' })">请求暂停</button>
            <button class="ghost full" @click="requestHostControl({ action: 'seek', positionSeconds: Math.max(0, (remoteStreamVideoRef?.currentTime || 0) + 30) })">请求快进 30 秒</button>
          </template>
        </section>
      </aside>
    </section>
  </main>
</template>
