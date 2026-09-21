/** 本地模式桌面验收：读真实后端，写操作拦截到独立内存夹具，不触碰用户密钥。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtime = process.env.AI_ME_PLAYWRIGHT_MODULE;
const { _electron } = await import(runtime ? pathToFileURL(runtime).href : "playwright");
const root = path.resolve("..");
await mkdir(path.join(root, "tmp"), { recursive: true });
await mkdir(path.join(root, "output/playwright"), { recursive: true });
const profile = await mkdtemp(path.join(root, "tmp/local-models-"));
const electron = await _electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: [".", `--user-data-dir=${profile}`], cwd: process.cwd(),
});
try {
  const page = await electron.firstWindow();
  const errors = [];
  const accountRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && /oauth|checkout|pricing|billing|subscription/i.test(url.href)) accountRequests.push(url.href);
  });
  await page.getByTestId("ai-me-preferences-trigger").waitFor({ timeout: 60000 });
  await page.getByTestId("ai-me-preferences-trigger").click();
  const menu = page.getByRole("menu");
  assert.doesNotMatch(await menu.innerText(), /连接使用|登录|登出|升级|套餐|Coding Plan/);
  assert.match(await menu.innerText(), /界面主题/);
  await page.keyboard.press("Escape");
  await page.getByTestId("task-settings-button").click();
  await page.getByTestId("settings-section-nav-modelProvider").click();
  await page.getByTestId("ai-me-model-settings").waitFor();
  await page.getByText("正在读取模型配置…").waitFor({ state: "hidden" });
  assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
  assert.equal(await page.getByRole("button", { name: /登录|升级套餐|购买/ }).count(), 0);
  await page.screenshot({ path: path.join(root, "output/playwright/desktop-local-model-settings.png") });

  // 以下写入只命中夹具，验证真实组件到 AI-ME HTTP 适配器的交互与错误处理。
  let saved = false;
  let attempts = 0;
  const configuration = { id: "e2e-local-model", provider: "acceptance", modelId: "test", modelRef: "acceptance/test", displayName: "本地验收模型", credentialStored: true, contextWindow: 128000 };
  await page.route("**/api/settings/models", async (route) => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      assert.equal(input.provider, "acceptance");
      assert.equal(input.apiKey, "e2e-not-a-real-key");
      attempts++;
      if (attempts === 1) {
        await route.fulfill({ status: 503, json: { detail: "验收：暂时不可用" } });
        return;
      }
      saved = true;
      await route.fulfill({ status: 201, json: configuration });
    } else await route.fulfill({ json: saved ? [configuration] : [] });
  });
  await page.route("**/api/models", (route) => route.fulfill({ json: saved ? [{ ref: "acceptance/test", provider: "acceptance", model_id: "test", display_name: "本地验收模型", context_window: 128000 }] : [] }));
  await page.getByLabel("快速配置").selectOption("custom");
  await page.getByLabel("厂商标识", { exact: true }).fill("acceptance");
  await page.getByLabel("模型 ID", { exact: true }).fill("test");
  await page.getByLabel("显示名称", { exact: true }).fill("本地验收模型");
  await page.getByLabel("API Key", { exact: true }).fill("e2e-not-a-real-key");
  await page.getByRole("button", { name: "保存并启用" }).click();
  await page.getByRole("alert").filter({ hasText: "暂时不可用" }).waitFor();
  await page.getByRole("button", { name: "保存并启用" }).click();
  await page.getByText("本地验收模型 已可用于新会话").waitFor();
  assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
  assert.equal(attempts, 2);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("e2e-not-a-real-key")), false);
  await page.getByTestId("settings-back-button").click();
  await page.getByTestId("chat-model-select-trigger").click();
  await page.getByRole("menuitem", { name: "acceptance", exact: true }).waitFor();
  await page.getByRole("menuitem", { name: "管理模型" }).click();
  await page.getByTestId("ai-me-model-settings").waitFor();

  // 全新数据目录同样可配置模型，且无边框窗口仍保留关闭按钮。
  saved = false;
  await page.route("**/api/projects", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/sessions", (route) => route.fulfill({ json: [] }));
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("zcode:auth:jwt-invalid-restart", "1"); });
  await page.reload();
  await page.getByRole("heading", { name: "开始使用 AI-ME" }).waitFor();
  await page.getByText("暂无模型，请在下方添加。").waitFor();
  assert.equal(await page.getByTestId("window-control-close").count(), 1);
  await page.screenshot({ path: path.join(root, "output/playwright/desktop-local-first-run.png") });
  assert.deepEqual(errors, []);
  assert.deepEqual(accountRequests, []);
  console.log("PASS: 本地偏好 / 无登录购买 / 真实配置读取 / 隔离保存重试 / 密钥清空 / 即时模型刷新 / 管理模型入口 / 首次使用窗控");
} finally { await electron.close(); }
