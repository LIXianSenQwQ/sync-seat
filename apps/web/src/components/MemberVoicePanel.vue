<script setup lang="ts">
import type { RoomState } from "@sync-seat/shared";
import { IconCrown, IconPhone, IconPhoneOff, IconMicrophone, IconMicrophoneOff } from "@tabler/icons-vue";

defineProps<{
  members: RoomState["members"];
  ownerId: string | null;
  voiceJoined: boolean;
  voiceJoining: boolean;
  muted: boolean;
  volume: number;
  voiceRelayError: string;
  nickname: string;
}>();

const emit = defineEmits<{
  joinVoice: [];
  leaveVoice: [];
  toggleMute: [];
  "update:volume": [value: number];
}>();
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 语音控制区 -->
    <div>
      <p class="text-eyebrow text-text-muted mb-3">语音通话</p>

      <template v-if="!voiceJoined">
        <button
          class="flex items-center justify-center gap-2 w-full py-2 rounded-button bg-brand-500 text-white font-medium text-body-sm transition-colors duration-150 hover:bg-brand-600 disabled:opacity-50"
          :disabled="voiceJoining"
          @click="emit('joinVoice')"
        >
          <IconPhone :size="16" />
          {{ voiceJoining ? "正在加入…" : "加入语音" }}
        </button>
      </template>

      <template v-else>
        <div class="flex gap-2">
          <button
            class="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-button text-body-sm transition-colors duration-150"
            :class="muted ? 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25' : 'bg-white/8 text-text-primary hover:bg-white/14'"
            @click="emit('toggleMute')"
          >
            <IconMicrophoneOff v-if="muted" :size="16" />
            <IconMicrophone v-else :size="16" />
            {{ muted ? "取消静音" : "静音" }}
          </button>
          <button
            class="flex items-center justify-center gap-1.5 px-3 py-2 rounded-button bg-status-busy/15 text-status-busy text-body-sm transition-colors duration-150 hover:bg-status-busy/25"
            @click="emit('leaveVoice')"
          >
            <IconPhoneOff :size="16" />
          </button>
        </div>

        <label class="flex flex-col gap-1.5 mt-3">
          <span class="text-caption text-text-muted">语音总音量</span>
          <input
            :value="volume"
            type="range"
            min="0"
            max="1"
            step="0.05"
            class="w-full h-1.5 rounded-full appearance-none bg-white/10 cursor-pointer accent-brand-500"
            @input="emit('update:volume', parseFloat(($event.target as HTMLInputElement).value))"
          />
        </label>

        <p v-if="voiceRelayError" class="mt-2 text-body-sm text-status-busy leading-relaxed">
          {{ voiceRelayError }}
        </p>
      </template>

      <p class="text-caption text-text-muted mt-2">当前身份：{{ nickname }}</p>
    </div>

    <!-- 分隔 -->
    <div class="border-t border-white/5" />

    <!-- 成员列表 -->
    <div>
      <p class="text-eyebrow text-text-muted mb-2">房间成员 · {{ members.length }}/3</p>
      <div class="flex flex-col gap-1">
        <div
          v-for="member in members"
          :key="member.memberId"
          class="flex items-center gap-2.5 px-2 py-1.5 rounded"
        >
          <div
            class="relative flex items-center justify-center w-8 h-8 rounded-avatar text-body-sm font-semibold shrink-0"
            :class="member.connected ? 'bg-brand-500 text-white' : 'bg-white/8 text-text-muted'"
          >
            {{ member.nickname.charAt(0) }}
            <span
              class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-surface-sidebar"
              :class="member.connected ? 'bg-status-online' : 'bg-status-offline'"
            />
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1">
              <span
                class="text-body-sm truncate"
                :class="member.connected ? 'text-text-primary' : 'text-text-muted'"
              >
                {{ member.nickname }}
              </span>
              <IconCrown
                v-if="member.memberId === ownerId"
                :size="12"
                class="text-amber-400 shrink-0"
              />
            </div>
            <div class="flex items-center gap-1.5 text-caption text-text-muted">
              <span>{{ member.memberId === ownerId ? "房主" : "成员" }}</span>
              <span v-if="member.voiceJoined" class="text-status-online">
                · {{ member.muted ? "已静音" : "语音中" }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
