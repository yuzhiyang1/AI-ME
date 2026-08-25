import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // 使用相对资源路径，使同一份构建产物既能由 Web 服务托管，也能被 Electron 本地加载。
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
  },
});

