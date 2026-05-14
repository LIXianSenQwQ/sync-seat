<script setup lang="ts">
import { IconMovie } from "@tabler/icons-vue";

defineProps<{
  isEmpty: boolean;
  emptyMessage: string;
}>();
</script>

<template>
  <div class="relative flex-1 min-h-0 bg-black rounded-lg overflow-hidden">
    <slot />

    <!-- 空状态 -->
    <div
      v-if="isEmpty"
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-text-muted"
    >
      <IconMovie :size="48" class="opacity-30" />
      <p class="text-body">{{ emptyMessage }}</p>
    </div>
  </div>
</template>
