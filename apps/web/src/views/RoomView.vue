<script setup lang="ts">
import type { ClientRoomEvent, DriveEntry, HostControlCommand, RoomState } from "@sync-seat/shared";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../services/api";
import { HostStreamMesh } from "../services/host-stream";
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
const localVideoUrl = ref("");
const localVideoName = ref("");
const remoteStreamReady = ref(false);
let calibrationTimer: number | null = null;

const members = computed(() => room.value?.members ?? []);
const currentMember = computed(() => members.value.find((member) => member.memberId === identity.memberId));
const isOwner = computed(() => room.value?.ownerId === identity.memberId);
const isDirectMode = computed(() => room.value?.watchMode === "direct");
const isHostStreamMode = computed(() => room.value?.watchMode === "host-stream");

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
    if (!current.members.some((member) => member.memberId === identity.memberId)) {
      return false;
    }
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
      void ensureHostStream().then((mesh) => mesh.handleSignal(event.fromMemberId, event.signalType, event.payload));
    },
    (event) => {
      applyHostControl(event);
    },
    (reason) => {
      error.value = reason;
      room.value = null;
      hostStream.value?.stop();
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
  const iceServers = await api.getIceServers();
  hostStream.value = new HostStreamMesh(
    iceServers,
    identity.memberId,
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
      remoteStreamReady.value = true;
      await nextTick();
      if (remoteStreamVideoRef.value) {
        remoteStreamVideoRef.value.srcObject = stream;
        await remoteStreamVideoRef.value.play().catch(() => undefined);
      }
    }
  );
  return hostStream.value;
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
    const mesh = await ensureHostStream();
    mesh.captureFromVideo(hostVideoRef.value);
    await hostVideoRef.value.play();
    send({ type: "host_stream_start", roomCode: roomCode.value, memberId: identity.memberId, fileName: localVideoName.value });
    await mesh.publishToMembers(room.value.members);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "开始推流失败";
  }
}

function stopHostStream(): void {
  hostStream.value?.stop();
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
  const iceServers = await api.getIceServers();
  voice.value = new VoiceMesh(iceServers, identity.memberId, (targetMemberId, type, payload) => {
    send({
      type: type === "offer" ? "voice_offer" : type === "answer" ? "voice_answer" : "voice_ice_candidate",
      roomCode: roomCode.value,
      memberId: identity.memberId,
      targetMemberId,
      ...(type === "ice_candidate" ? { candidate: payload } : { description: payload })
    } as ClientRoomEvent);
  });
  await voice.value.join(members.value);
  voice.value.setVolume(volume.value);
  voiceJoined.value = true;
  send({ type: "voice_join", roomCode: roomCode.value, memberId: identity.memberId });
}

function leaveVoice(): void {
  voice.value?.leave();
  voice.value = null;
  voiceJoined.value = false;
  muted.value = false;
  send({ type: "voice_leave", roomCode: roomCode.value, memberId: identity.memberId });
}

function toggleMute(): void {
  muted.value = !muted.value;
  voice.value?.setMuted(muted.value);
  send({ type: "voice_mute", roomCode: roomCode.value, memberId: identity.memberId, muted: muted.value });
}

watch(volume, (value) => voice.value?.setVolume(value));

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
          <button v-if="!voiceJoined" class="primary full" @click="joinVoice">加入语音</button>
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
            <button class="primary full" :disabled="!localVideoUrl" @click="startHostStream">开始推流</button>
            <button class="danger full" :disabled="!room.hostStreamState?.streaming" @click="stopHostStream">停止推流</button>
          </template>
          <template v-else>
            <p class="side-note">{{ room.hostStreamState?.streaming ? (remoteStreamReady ? '正在接收房主推流' : '等待房主媒体连接') : '房主尚未开始推流' }}</p>
            <button class="ghost full" @click="requestHostControl({ action: 'play' })">请求播放</button>
            <button class="ghost full" @click="requestHostControl({ action: 'pause' })">请求暂停</button>
            <button class="ghost full" @click="requestHostControl({ action: 'seek', positionSeconds: Math.max(0, (remoteStreamVideoRef?.currentTime || 0) + 30) })">请求快进 30 秒</button>
          </template>
        </section>
      </aside>
    </section>
  </main>
</template>
