<script setup lang="ts">
import type { DriveEntry } from "@sync-seat/shared";
import FunctionNav, { type FunctionSection } from "./FunctionNav.vue";
import FileTree from "./FileTree.vue";
import MemberVoicePanel from "./MemberVoicePanel.vue";
import StreamPanel from "./StreamPanel.vue";
import type { RoomState } from "@sync-seat/shared";

defineProps<{
  activeSection: FunctionSection;
  entries: DriveEntry[];
  currentPath: string;
  currentVideoPath: string | null;
  room: RoomState | null;
  isDirectMode: boolean;
  isHostStreamMode: boolean;
  isOwner: boolean;
  voiceJoined: boolean;
  voiceJoining: boolean;
  muted: boolean;
  volume: number;
  voiceRelayError: string;
  hostStreamQuality: string;
  hostStreamQualityOptions: { label: string; value: string }[];
  remoteStreamReady: boolean;
  hostStreamDiagnosticLabels: string[];
  hasTerminalHostStreamError: boolean;
  subtitles: DriveEntry[];
  currentSubtitlePath: string | null;
  localVideoUrl: string;
  roomStreaming: boolean;
  members: RoomState["members"];
  currentMember: RoomState["members"][number] | undefined;
}>();

const emit = defineEmits<{
  selectSection: [section: FunctionSection];
  navigate: [path: string];
  loadVideo: [path: string];
  goUp: [];
  joinVoice: [];
  leaveVoice: [];
  toggleMute: [];
  "update:volume": [value: number];
  selectLocalVideo: [event: Event];
  "update:hostStreamQuality": [quality: string];
  startHostStream: [];
  stopHostStream: [];
  requestHostControl: [command: { action: "play" | "pause" }];
  selectSubtitle: [path: string | null];
}>();
</script>

<template>
  <aside class="flex flex-col w-[240px] shrink-0 bg-surface-sidebar border-l border-white/5 overflow-y-auto">
    <!-- 功能区导航 -->
    <div class="px-2 pt-3 pb-2 border-b border-white/5">
      <FunctionNav
        :active-section="activeSection"
        @select="emit('selectSection', $event)"
      />
    </div>

    <!-- 功能面板内容 -->
    <div class="flex-1 overflow-y-auto">
      <!-- 成员与语音 -->
      <div v-if="activeSection === 'members-voice'" class="py-2 px-3">
        <MemberVoicePanel
          :members="members"
          :owner-id="room?.ownerId ?? null"
          :voice-joined="voiceJoined"
          :voice-joining="voiceJoining"
          :muted="muted"
          :volume="volume"
          :voice-relay-error="voiceRelayError"
          :nickname="currentMember?.nickname ?? ''"
          @join-voice="emit('joinVoice')"
          @leave-voice="emit('leaveVoice')"
          @toggle-mute="emit('toggleMute')"
          @update:volume="emit('update:volume', $event)"
        />
      </div>

      <!-- 资源库 -->
      <div v-if="activeSection === 'resources' && isDirectMode" class="py-2">
        <FileTree
          :entries="entries"
          :current-path="currentPath"
          :current-video-path="currentVideoPath"
          @navigate="emit('navigate', $event)"
          @load-video="emit('loadVideo', $event)"
          @go-up="emit('goUp')"
        />
      </div>

      <!-- 资源库：推流面板（房主推流模式） -->
      <div v-if="activeSection === 'resources' && isHostStreamMode" class="py-2 px-3">
        <StreamPanel
          :is-owner="isOwner"
          :local-video-url="localVideoUrl"
          :host-stream-quality="hostStreamQuality"
          :host-stream-quality-options="hostStreamQualityOptions"
          :remote-stream-ready="remoteStreamReady"
          :host-stream-diagnostic-labels="hostStreamDiagnosticLabels"
          :has-terminal-host-stream-error="hasTerminalHostStreamError"
          :room-streaming="roomStreaming"
          @select-local-video="emit('selectLocalVideo', $event)"
          @update:host-stream-quality="emit('update:hostStreamQuality', $event)"
          @start-host-stream="emit('startHostStream')"
          @stop-host-stream="emit('stopHostStream')"
          @request-host-control="emit('requestHostControl', $event)"
        />
      </div>

      <!-- 字幕面板（直链模式资源库底部） -->
      <div
        v-if="activeSection === 'resources' && isDirectMode && subtitles.length > 0"
        class="px-3 py-2 border-t border-white/5"
      >
        <p class="text-eyebrow text-text-muted mb-1.5">字幕</p>
        <button
          class="w-full text-left px-2 py-1 rounded text-body-sm text-text-secondary hover:bg-white/6 transition-colors"
          @click="emit('selectSubtitle', null)"
        >
          清除字幕
        </button>
        <button
          v-for="sub in subtitles"
          :key="sub.path"
          class="w-full text-left px-2 py-1 rounded text-body-sm transition-colors hover:bg-white/6"
          :class="currentSubtitlePath === sub.path ? 'text-brand-300 bg-brand-500/10' : 'text-text-secondary'"
          @click="emit('selectSubtitle', sub.path)"
        >
          {{ currentSubtitlePath === sub.path ? '●' : '○' }} {{ sub.name }}
        </button>
      </div>
    </div>
  </aside>
</template>
