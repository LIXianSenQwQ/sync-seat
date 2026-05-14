<script setup lang="ts">
import type { DriveEntry } from "@sync-seat/shared";
import { IconFolder, IconMovie, IconSubtask, IconFile, IconArrowUp } from "@tabler/icons-vue";
import { computed } from "vue";

const props = defineProps<{
  entries: DriveEntry[];
  currentPath: string;
  currentVideoPath: string | null;
}>();

const emit = defineEmits<{
  navigate: [path: string];
  loadVideo: [path: string];
  goUp: [];
}>();

const dirs = computed(() => props.entries.filter((e) => e.type === "directory"));
const videos = computed(() => props.entries.filter((e) => e.type === "video"));

function entryIcon(type: string) {
  switch (type) {
    case "directory":
      return IconFolder;
    case "video":
      return IconMovie;
    case "subtitle":
      return IconSubtask;
    default:
      return IconFile;
  }
}

function entryColor(type: string): string {
  if (type === "video") return "text-amber-400";
  if (type === "directory") return "text-brand-300";
  return "text-text-muted";
}

function handleClick(entry: DriveEntry) {
  if (entry.type === "directory") {
    emit("navigate", entry.path);
  } else if (entry.type === "video") {
    emit("loadVideo", entry.path);
  }
}
</script>

<template>
  <div class="flex flex-col min-h-0">
    <!-- 路径导航 -->
    <div class="flex items-center gap-2 px-3 py-2">
      <span class="text-caption text-text-muted truncate flex-1">{{ currentPath }}</span>
      <button
        v-if="currentPath !== '/'"
        class="flex items-center justify-center w-6 h-6 rounded bg-white/6 text-text-muted hover:bg-white/12 hover:text-text-primary transition-colors shrink-0"
        title="上一级"
        @click="emit('goUp')"
      >
        <IconArrowUp :size="14" />
      </button>
    </div>

    <!-- 目录列表 -->
    <div v-if="dirs.length" class="px-1">
      <p class="text-eyebrow text-text-muted px-2 py-1.5">目录</p>
      <button
        v-for="entry in dirs"
        :key="entry.path"
        class="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left text-body-sm transition-colors duration-150 hover:bg-white/6"
        @click="handleClick(entry)"
      >
        <component :is="entryIcon(entry.type)" :size="16" :class="entryColor(entry.type)" />
        <span class="text-text-secondary truncate">{{ entry.name }}</span>
      </button>
    </div>

    <!-- 视频列表 -->
    <div v-if="videos.length" class="px-1 mt-1">
      <p class="text-eyebrow text-text-muted px-2 py-1.5">视频</p>
      <button
        v-for="entry in videos"
        :key="entry.path"
        class="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left text-body-sm transition-colors duration-150 hover:bg-white/6"
        :class="currentVideoPath === entry.path ? 'bg-brand-500/15 text-brand-300' : ''"
        @click="handleClick(entry)"
      >
        <component :is="entryIcon(entry.type)" :size="16" :class="entryColor(entry.type)" />
        <span
          class="truncate"
          :class="currentVideoPath === entry.path ? 'text-brand-300' : 'text-text-secondary'"
        >
          {{ entry.name }}
        </span>
      </button>
    </div>

    <p
      v-if="entries.length === 0"
      class="px-3 py-4 text-caption text-text-muted text-center"
    >
      暂无内容
    </p>
  </div>
</template>
