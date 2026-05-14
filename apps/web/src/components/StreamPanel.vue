<script setup lang="ts">
defineProps<{
  isOwner: boolean;
  localVideoUrl: string;
  hostStreamQuality: string;
  hostStreamQualityOptions: { label: string; value: string }[];
  remoteStreamReady: boolean;
  hostStreamDiagnosticLabels: string[];
  hasTerminalHostStreamError: boolean;
  roomStreaming: boolean;
}>();

const emit = defineEmits<{
  selectLocalVideo: [event: Event];
  "update:hostStreamQuality": [quality: string];
  startHostStream: [];
  stopHostStream: [];
  requestHostControl: [command: { action: "play" | "pause" }];
}>();
</script>

<template>
  <div class="flex flex-col gap-3">
    <p class="text-eyebrow text-text-muted">房主推流</p>

    <!-- 房主面板 -->
    <template v-if="isOwner">
      <label class="flex flex-col gap-1.5">
        <span class="text-caption text-text-muted">本地视频</span>
        <input
          type="file"
          accept=".mp4,.webm,.mov,.m3u8,video/mp4,video/webm,video/quicktime,application/vnd.apple.mpegurl"
          class="text-caption text-text-secondary file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:bg-white/8 file:text-text-primary file:text-caption file:cursor-pointer hover:file:bg-white/14"
          @change="emit('selectLocalVideo', $event)"
        />
      </label>

      <div class="flex flex-col gap-1.5">
        <span class="text-caption text-text-muted">清晰度</span>
        <div class="flex rounded bg-white/6 p-0.5">
          <button
            v-for="option in hostStreamQualityOptions"
            :key="option.value"
            class="flex-1 py-1 rounded text-caption transition-colors"
            :class="hostStreamQuality === option.value ? 'bg-brand-500 text-white' : 'text-text-muted hover:text-text-secondary'"
            @click="emit('update:hostStreamQuality', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <button
        class="w-full py-2 rounded-button bg-brand-500 text-white font-medium text-body-sm transition-colors duration-150 hover:bg-brand-600 disabled:opacity-50"
        :disabled="!localVideoUrl"
        @click="emit('startHostStream')"
      >
        开始推流
      </button>
      <button
        class="w-full py-2 rounded-button bg-status-busy/15 text-status-busy text-body-sm transition-colors duration-150 hover:bg-status-busy/25 disabled:opacity-50"
        :disabled="!roomStreaming"
        @click="emit('stopHostStream')"
      >
        停止推流
      </button>
    </template>

    <!-- 观众面板 -->
    <template v-else>
      <template v-if="roomStreaming">
        <p v-if="remoteStreamReady" class="text-body-sm text-status-online">
          正在接收房主推流
        </p>
        <p v-else class="text-body-sm text-text-secondary">
          等待房主媒体连接…
        </p>

        <div
          v-if="hostStreamDiagnosticLabels.length"
          class="text-caption text-text-muted leading-relaxed pl-2 border-l-2 border-brand-300/40"
        >
          <p v-for="label in hostStreamDiagnosticLabels" :key="label">{{ label }}</p>
        </div>

        <p
          v-if="hasTerminalHostStreamError"
          class="text-body-sm text-status-busy leading-relaxed"
        >
          IPv6 直连与 TURN 中继均连接失败，请检查双方网络、防火墙、TURN 配置，以及公网访问是否使用 HTTPS
        </p>
      </template>
      <p v-else class="text-body-sm text-text-muted">房主尚未开始推流</p>

      <div class="flex gap-2 mt-1">
        <button
          class="flex-1 py-1.5 rounded-button bg-white/8 text-text-secondary text-body-sm transition-colors hover:bg-white/14"
          @click="emit('requestHostControl', { action: 'play' })"
        >
          请求播放
        </button>
        <button
          class="flex-1 py-1.5 rounded-button bg-white/8 text-text-secondary text-body-sm transition-colors hover:bg-white/14"
          @click="emit('requestHostControl', { action: 'pause' })"
        >
          请求暂停
        </button>
      </div>
    </template>
  </div>
</template>
