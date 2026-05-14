<script setup lang="ts">
import { IconUsers, IconFolder } from "@tabler/icons-vue";
import type { Component } from "vue";

export type FunctionSection = "members-voice" | "resources";

defineProps<{
  activeSection: FunctionSection;
}>();

const emit = defineEmits<{
  select: [section: FunctionSection];
}>();

interface NavItem {
  id: FunctionSection;
  label: string;
  icon: Component;
}

const items: NavItem[] = [
  { id: "members-voice", label: "成员与语音", icon: IconUsers },
  { id: "resources", label: "资源库", icon: IconFolder }
];
</script>

<template>
  <nav class="flex flex-col gap-0.5" aria-label="功能区导航">
    <button
      v-for="item in items"
      :key="item.id"
      class="flex items-center gap-2.5 w-full px-3 py-1.5 rounded-button text-body-sm transition-colors duration-150 text-left"
      :class="activeSection === item.id
        ? 'bg-brand-500/20 text-brand-300'
        : 'text-text-secondary hover:bg-white/6 hover:text-text-primary'"
      @click="emit('select', item.id)"
    >
      <component :is="item.icon" :size="18" />
      {{ item.label }}
    </button>
  </nav>
</template>
