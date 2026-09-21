import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// 上游原始源码作为依赖保留，不把它的内部测试误当作 AI-ME 验收用例。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: { include: ["src/**/*.test.{ts,tsx,js,jsx}"] },
  }),
);
