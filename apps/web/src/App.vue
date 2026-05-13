<script setup lang="ts">
import packageMetadata from "../../../package.json";

/** 当前应用版本号，来自根 package.json，发布时用于核对前端构建版本。 */
const appVersion = `v${packageMetadata.version}`;
</script>

<template>
  <router-view />
  <span class="app-version" :title="`当前版本 ${appVersion}`">{{ appVersion }}</span>
</template>
