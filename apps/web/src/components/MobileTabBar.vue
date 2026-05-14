<script setup lang="ts">
import { IconUsers, IconFolder } from "@tabler/icons-vue";
import type { Component } from "vue";
import type { FunctionSection } from "./FunctionNav.vue";

defineProps<{
  activeSection: FunctionSection;
}>();

const emit = defineEmits<{
  select: [section: FunctionSection];
}>();

interface TabItem {
  id: FunctionSection;
  label: string;
  icon: Component;
}

const tabs: TabItem[] = [
  { id: "members-voice", label: "成员", icon: IconUsers },
  { id: "resources", label: "资源库", icon: IconFolder }
];
</script>

<template>
  <nav
    class="flex items-center justify-around h-14 bg-surface-sidebar border-t border-white/5 shrink-0 lg:hidden"
    aria-label="功能导航"
  >
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded transition-colors duration-150 min-w-0"
      :class="activeSection === tab.id
        ? 'text-brand-300'
        : 'text-text-muted'"
      @click="emit('select', tab.id)"
    >
      <component :is="tab.icon" :size="20" />
      <span class="text-[10px] leading-none">{{ tab.label }}</span>
    </button>
  </nav>
</template>
