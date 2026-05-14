<script setup lang="ts">
import { IconArrowLeft } from "@tabler/icons-vue";

defineProps<{
  roomCode: string;
  title: string;
  connected: boolean;
}>();

const emit = defineEmits<{
  back: [];
}>();
</script>

<template>
  <header
    class="flex items-center justify-between gap-4 h-12 px-4 bg-surface-sidebar border-b border-white/5 shrink-0"
  >
    <div class="flex items-center gap-3 min-w-0">
      <button
        class="flex items-center justify-center w-8 h-8 rounded-button bg-white/6 text-text-secondary hover:bg-white/12 hover:text-text-primary transition-colors duration-150 shrink-0"
        title="返回首页"
        @click="emit('back')"
      >
        <IconArrowLeft :size="18" />
      </button>
      <div class="min-w-0">
        <p class="text-eyebrow text-brand-300 truncate">房间 {{ roomCode }}</p>
        <h1 class="text-body font-semibold text-text-primary truncate">{{ title }}</h1>
      </div>
    </div>

    <div class="flex items-center gap-2 shrink-0">
      <span
        class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption transition-colors"
        :class="connected ? 'bg-status-online/12 text-status-online' : 'bg-white/6 text-text-muted'"
      >
        <span
          class="w-1.5 h-1.5 rounded-full"
          :class="connected ? 'bg-status-online' : 'bg-text-muted'"
        />
        {{ connected ? "已连接" : "未连接" }}
      </span>
    </div>
  </header>
</template>
