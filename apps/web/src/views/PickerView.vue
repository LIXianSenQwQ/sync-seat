<script setup lang="ts">
import type { DriveEntry } from "@sync-seat/shared";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../services/api";
import { getIdentity } from "../services/identity";

const router = useRouter();
const identity = getIdentity();
const currentPath = ref("/");
const entries = ref<DriveEntry[]>([]);
const loading = ref(false);
const error = ref("");
const selectedVideo = ref<DriveEntry | null>(null);
const roomPassword = ref("");

const directories = computed(() => entries.value.filter((entry) => entry.type === "directory"));
const videos = computed(() => entries.value.filter((entry) => entry.type === "video"));

async function load(path: string): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    currentPath.value = path;
    entries.value = await api.listDrive(path);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "目录加载失败";
  } finally {
    loading.value = false;
  }
}

async function createRoomWithVideo(): Promise<void> {
  const response = await api.createRoom({
    memberId: identity.memberId,
    nickname: identity.nickname,
    password: roomPassword.value || undefined,
    watchMode: "direct"
  });
  await router.push({
    path: `/room/${response.room.roomCode}`,
    query: selectedVideo.value ? { video: selectedVideo.value.path } : undefined
  });
}

function parentPath(): string {
  if (currentPath.value === "/") return "/";
  const parts = currentPath.value.split("/").filter(Boolean);
  parts.pop();
  return `/${parts.join("/")}`;
}

onMounted(() => load("/"));
</script>

<template>
  <main class="page-shell">
    <header class="topbar">
      <button class="icon-button" title="返回首页" @click="router.push('/')">←</button>
      <div>
        <p class="eyebrow">选片</p>
        <h1>浏览网盘资源</h1>
      </div>
      <button class="ghost" :disabled="!selectedVideo" @click="createRoomWithVideo">用所选视频建房</button>
    </header>

    <section class="browser-layout">
      <aside class="card side-card">
        <span class="label">当前路径</span>
        <strong>{{ currentPath }}</strong>
        <button class="ghost full" :disabled="currentPath === '/'" @click="load(parentPath())">上一级</button>
        <label class="field">
          <span>房间密码</span>
          <input v-model="roomPassword" type="password" placeholder="可选" />
        </label>
      </aside>

      <section class="card file-card">
        <div class="file-header">
          <h2>目录</h2>
          <span v-if="loading">加载中...</span>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
        <div class="file-list">
          <button v-for="entry in directories" :key="entry.path" class="file-row" @click="load(entry.path)">
            <span class="file-kind">目录</span>
            <span>{{ entry.name }}</span>
          </button>
          <button
            v-for="entry in videos"
            :key="entry.path"
            class="file-row"
            :class="{ selected: selectedVideo?.path === entry.path }"
            @click="selectedVideo = entry"
          >
            <span class="file-kind video">视频</span>
            <span>{{ entry.name }}</span>
          </button>
        </div>
      </section>
    </section>
  </main>
</template>
