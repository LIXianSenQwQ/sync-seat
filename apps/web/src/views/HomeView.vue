<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../services/api";
import { getIdentity, saveNickname } from "../services/identity";

const router = useRouter();
const identity = ref(getIdentity());
const nickname = ref(identity.value.nickname);
const roomCode = ref("");
const password = ref("");
const watchMode = ref<"direct" | "host-stream">("direct");
const creating = ref(false);
const error = ref("");

async function createRoom(): Promise<void> {
  error.value = "";
  creating.value = true;
  try {
    identity.value = saveNickname(nickname.value);
    const response = await api.createRoom({
      memberId: identity.value.memberId,
      nickname: identity.value.nickname,
      password: password.value || undefined,
      watchMode: watchMode.value
    });
    await router.push(`/room/${response.room.roomCode}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "创建房间失败";
  } finally {
    creating.value = false;
  }
}

async function joinRoom(): Promise<void> {
  identity.value = saveNickname(nickname.value);
  await router.push(`/room/${roomCode.value.trim().toUpperCase()}`);
}
</script>

<template>
  <main class="entry-shell">
    <section class="entry-panel">
      <p class="eyebrow">Sync Seat</p>
      <h1>网盘同步观影房间</h1>
      <p class="entry-copy">连接 AList/OpenList，创建轻量房间，最多 3 人同步看片和语音。</p>

      <label class="field">
        <span>昵称</span>
        <input v-model="nickname" maxlength="24" placeholder="输入昵称或使用随机昵称" />
      </label>

      <div class="actions-grid">
        <div class="action-card">
          <h2>创建房间</h2>
          <div class="mode-toggle">
            <button :class="{ active: watchMode === 'direct' }" @click="watchMode = 'direct'">直链同步</button>
            <button :class="{ active: watchMode === 'host-stream' }" @click="watchMode = 'host-stream'">房主推流</button>
          </div>
          <label class="field">
            <span>可选密码</span>
            <input v-model="password" type="password" placeholder="留空则无需密码" />
          </label>
          <button class="primary" :disabled="creating" @click="createRoom">创建空房间</button>
          <button class="ghost" @click="router.push('/picker')">先浏览网盘</button>
        </div>

        <div class="action-card">
          <h2>加入房间</h2>
          <label class="field">
            <span>房间码</span>
            <input v-model="roomCode" maxlength="6" placeholder="ABC123" />
          </label>
          <button class="primary" :disabled="!roomCode.trim()" @click="joinRoom">进入房间</button>
        </div>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
    </section>
  </main>
</template>
