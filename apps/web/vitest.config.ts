import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"]
  }
});
