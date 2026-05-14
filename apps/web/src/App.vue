<script setup lang="ts">
import packageMetadata from "../../../package.json";

const appVersion = `v${packageMetadata.version}`;
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden bg-surface-deepest text-text-primary">
    <!-- 主内容区 -->
    <div class="flex flex-1 min-w-0 flex-col">
      <router-view v-slot="{ Component, route }">
        <Transition
          :name="(route.meta.transition as string) || 'view-fade'"
          mode="out-in"
        >
          <component :is="Component" :key="route.path" />
        </Transition>
      </router-view>
    </div>

    <!-- 版本号角标 -->
    <span
      class="fixed bottom-3 left-3 z-20 pointer-events-none border border-white/8 rounded-full bg-surface-deepest/70 text-text-muted text-xs font-bold leading-none px-2.5 py-1.5"
      :title="`当前版本 ${appVersion}`"
    >
      {{ appVersion }}
    </span>
  </div>
</template>

<style>
.view-fade-enter-active {
  transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1),
              translate 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.view-fade-leave-active {
  transition: opacity 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}
.view-fade-enter-from {
  opacity: 0;
  translate: 0 12px;
}
.view-fade-leave-to {
  opacity: 0;
}
</style>
