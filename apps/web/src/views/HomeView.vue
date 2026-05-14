<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useIdentityStore } from "../stores/identity";
import { api } from "../services/api";
import { IconPlus, IconLogin2, IconMovie, IconDice } from "@tabler/icons-vue";

const router = useRouter();
const identityStore = useIdentityStore();

const nickname = ref(identityStore.nickname);
const roomCode = ref("");
const password = ref("");
const watchMode = ref<"direct" | "host-stream">("direct");
const creating = ref(false);
const showCreateModal = ref(false);
const showJoinModal = ref(false);
const error = ref("");

const roomCodeReady = computed(() => /^\d{4}$/.test(roomCode.value));

function randomNickname(): void {
  const adj = [
    "好动的", "呆萌的", "蹦跳的", "慵懒的", "狂奔的", "打嗝的", "熬夜的",
    "打盹的", "晃悠的", "哼哼的", "翻滚的", "发呆的", "挠墙的", "嘴馋的",
    "散步的", "抠脚的", "迷路的", "吃撑的", "傻笑的", "飞快的"
  ];
  const animal = [
    "猫咪", "熊猫", "兔子", "树懒", "拖鞋", "河豚", "考拉", "企鹅",
    "仓鼠", "柴犬", "海獭", "水豚", "羊驼", "橘猫", "二哈", "刺猬",
    "松鼠", "海豚", "狐狸", "小鹿"
  ];
  nickname.value = `${adj[Math.floor(Math.random() * adj.length)]}${animal[Math.floor(Math.random() * animal.length)]}`;
}

function normalizeRoomCodeInput(): void {
  roomCode.value = roomCode.value.replace(/\D/g, "").slice(0, 4);
}

async function createRoom(): Promise<void> {
  error.value = "";
  creating.value = true;
  try {
    identityStore.saveNickname(nickname.value);
    const response = await api.createRoom({
      memberId: identityStore.memberId,
      nickname: identityStore.nickname,
      password: password.value || undefined,
      watchMode: watchMode.value
    });
    await router.push(`/room/${response.room.roomCode}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "创建房间失败";
  } finally {
    creating.value = false;
    showCreateModal.value = false;
  }
}

async function joinRoom(): Promise<void> {
  normalizeRoomCodeInput();
  if (!roomCodeReady.value) return;
  identityStore.saveNickname(nickname.value);
  await router.push(`/room/${roomCode.value}`);
  showJoinModal.value = false;
}
</script>

<template>
  <main class="flex-1 flex flex-col items-center justify-center p-8 bg-surface-main">
    <!-- 欢迎卡片 -->
    <div class="flex flex-col items-center max-w-md w-full">
      <!-- Logo -->
      <div
        class="w-20 h-20 rounded-avatar bg-brand-500 flex items-center justify-center mb-6 shadow-lg shadow-brand-500/20"
      >
        <IconMovie :size="40" class="text-white" />
      </div>

      <h1 class="text-title text-text-primary mb-2">Sync Seat</h1>
      <p class="text-eyebrow text-brand-300 mb-4">网盘同步观影房间</p>
      <p class="text-body text-text-secondary leading-relaxed text-center mb-8">
        连接 AList/OpenList，创建轻量房间，最多 3 人同步看片和语音。
      </p>

      <!-- 昵称输入 -->
      <div class="w-full mb-6">
        <label class="text-body-sm text-text-secondary block mb-2">你的昵称</label>
        <div class="flex gap-2">
          <input
            v-model="nickname"
            maxlength="24"
            placeholder="输入昵称"
            class="flex-1 px-3 py-2.5 rounded-button bg-surface-elevated border border-white/10 text-text-primary outline-none focus:border-brand-500 transition-colors"
          />
          <button
            class="flex items-center justify-center w-10 h-10 rounded-button bg-white/8 text-text-secondary hover:bg-white/14 hover:text-text-primary transition-colors shrink-0"
            title="随机昵称"
            @click="randomNickname"
          >
            <IconDice :size="18" />
          </button>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="flex gap-3 w-full">
        <button
          class="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-button bg-brand-500 text-white font-medium transition-colors duration-150 hover:bg-brand-600"
          @click="showCreateModal = true"
        >
          <IconPlus :size="18" />
          创建房间
        </button>
        <button
          class="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-button bg-white/8 text-text-primary font-medium transition-colors duration-150 hover:bg-white/14"
          @click="showJoinModal = true"
        >
          <IconLogin2 :size="18" />
          加入房间
        </button>
      </div>
    </div>

    <!-- 创建房间模态框 -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showCreateModal"
          class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-surface-overlay"
          @click.self="showCreateModal = false"
        >
          <div class="w-full max-w-md bg-surface-elevated rounded-modal p-6 shadow-2xl">
            <h2 class="text-heading text-text-primary mb-4">创建新房间</h2>

            <div class="flex rounded-button bg-surface-deepest border border-white/10 p-1 mb-4">
              <button
                class="flex-1 py-1.5 rounded text-body-sm transition-colors"
                :class="watchMode === 'direct' ? 'bg-brand-500 text-white' : 'text-text-muted'"
                @click="watchMode = 'direct'"
              >
                直链同步
              </button>
              <button
                class="flex-1 py-1.5 rounded text-body-sm transition-colors"
                :class="watchMode === 'host-stream' ? 'bg-brand-500 text-white' : 'text-text-muted'"
                @click="watchMode = 'host-stream'"
              >
                房主推流
              </button>
            </div>

            <label class="block mb-5">
              <span class="text-body-sm text-text-secondary block mb-1.5">可选密码</span>
              <input
                v-model="password"
                type="password"
                placeholder="留空则无需密码"
                class="w-full px-3 py-2.5 rounded-button bg-surface-deepest border border-white/10 text-text-primary outline-none focus:border-brand-500 transition-colors"
              />
            </label>

            <div class="flex justify-end gap-3">
              <button
                class="px-4 py-2 rounded-button bg-white/8 text-text-primary transition-colors duration-150 hover:bg-white/14"
                @click="showCreateModal = false"
              >
                取消
              </button>
              <button
                class="px-4 py-2 rounded-button bg-brand-500 text-white font-medium transition-colors duration-150 hover:bg-brand-600 disabled:opacity-50"
                :disabled="creating"
                @click="createRoom"
              >
                {{ creating ? "创建中..." : "创建房间" }}
              </button>
            </div>

            <p v-if="error" class="mt-3 text-body-sm text-status-busy">{{ error }}</p>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 加入房间模态框 -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showJoinModal"
          class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-surface-overlay"
          @click.self="showJoinModal = false"
        >
          <div class="w-full max-w-sm bg-surface-elevated rounded-modal p-6 shadow-2xl">
            <h2 class="text-heading text-text-primary mb-4">加入房间</h2>

            <label class="block mb-5">
              <span class="text-body-sm text-text-secondary block mb-1.5">房间号</span>
              <input
                v-model="roomCode"
                inputmode="numeric"
                maxlength="4"
                pattern="[0-9]*"
                placeholder="1234"
                class="w-full px-3 py-2.5 rounded-button bg-surface-deepest border border-white/10 text-text-primary outline-none focus:border-brand-500 transition-colors tracking-widest text-center"
                @input="normalizeRoomCodeInput"
              />
            </label>

            <div class="flex justify-end gap-3">
              <button
                class="px-4 py-2 rounded-button bg-white/8 text-text-primary transition-colors duration-150 hover:bg-white/14"
                @click="showJoinModal = false"
              >
                取消
              </button>
              <button
                class="px-4 py-2 rounded-button bg-brand-500 text-white font-medium transition-colors duration-150 hover:bg-brand-600 disabled:opacity-50"
                :disabled="!roomCodeReady"
                @click="joinRoom"
              >
                进入房间
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </main>
</template>

<style scoped>
.modal-enter-active {
  transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.modal-leave-active {
  transition: opacity 0.15s ease-in;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from > div {
  transform: scale(0.95);
}
.modal-enter-to > div {
  transform: scale(1);
}
.modal-leave-from > div {
  transform: scale(1);
}
.modal-leave-to > div {
  transform: scale(0.95);
}
.modal-enter-active > div {
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.modal-leave-active > div {
  transition: transform 0.15s ease-in;
}
</style>
