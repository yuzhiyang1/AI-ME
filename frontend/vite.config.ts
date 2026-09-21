import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const upstream = resolve(__dirname, "vendor/zcode/packages");
// AI-ME 没有 ZCode 账号/付费体系：构建时替换整条入口，不加载 OAuth 和购买面板。
const localAccountModules = [
  "settings/CodingPlanUpgradeDialogProvider",
  "settings/CodingPlanEntryButton",
  "root/useRootOAuthEffects",
  "hooks/useTokenRefresh",
  "WelcomeScreen",
  "v4/ConversationQuotaBanner",
];
// 防止后续同步上游时，新的间接导入绕过本地替换又把登录/购买实现打进客户端。
const accountBundleGuard: Plugin = {
  name: "ai-me-no-account-bundle",
  generateBundle(_options, bundle) {
    const forbidden =
      /\/(WelcomeScreen\.tsx|hooks\/useOAuth\.ts|root\/useRootOAuthEffects\.ts|login\/LoginApiKeyForm\.tsx|settings\/CodingPlan(?:UpgradeDialog|EmbeddedWebviewDialog)\.tsx)$/;
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== "chunk") continue;
      for (const id of Object.keys(chunk.modules)) {
        if (forbidden.test(id.replaceAll("\\", "/"))) {
          throw new Error(`AI-ME 构建禁止包含 ZCode 登录/购买实现：${id}`);
        }
      }
    }
  },
};
const packages = [
  "ui",
  "shared",
  "rpc",
  "provider",
  "model-option-map",
  "services",
  "client",
];

export default defineConfig({
  // 使用相对资源路径，使同一份构建产物既能由 Web 服务托管，也能被 Electron 本地加载。
  base: "./",
  plugins: [react(), tailwindcss(), accountBundleGuard],
  resolve: {
    alias: [
      ...localAccountModules.map((name) => ({
        find: `@/${name}.js`,
        replacement: resolve(__dirname, "src/workbench/local-account.jsx"),
      })),
      {
        find: "@/settings/ModelProviderSection.js",
        replacement: resolve(__dirname, "src/workbench/LocalModelSettings.jsx"),
      },
      {
        find: "@zcode/zcode-cua/broker/ports",
        replacement: `${upstream}/zcode-cua/broker-ports.js`,
      },
      { find: "@", replacement: `${upstream}/ui/src` },
      ...packages.map((name) => ({
        find: new RegExp(`^@zcode/${name}$`),
        replacement: `${upstream}/${name}/src/index.ts`,
      })),
      {
        find: "@zcode/shared/zcode-protocol-v4",
        replacement: `${upstream}/shared/src/zcode-protocol-v4/index.ts`,
      },
      {
        find: /^@zcode\/shared\/(.*)$/,
        replacement: `${upstream}/shared/src/$1.ts`,
      },
    ],
    dedupe: ["react", "react-dom"],
  },
  define: {
    __ZCODE_VERSION__: JSON.stringify("AI-ME / ZCode 872ad96"),
    __ZCODE_COMMIT__: JSON.stringify("872ad96"),
    __ZCODE_ENV__: JSON.stringify("test"),
    __ZCODE_ENDPOINT_ENV__: JSON.stringify({}),
  },
  worker: { format: "es", rollupOptions: { treeshake: false } },
  server: {
    port: 5173,
  },
});
