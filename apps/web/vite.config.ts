import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        xfwd: true
      },
      "/socket.io": {
        target: "http://localhost:3000",
        ws: true,
        xfwd: true
      }
    }
  }
});
