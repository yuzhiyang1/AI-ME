/** Electron 实机验收：使用独立 profile，不关闭或改动用户正在使用的工作台。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 可复用本机 Playwright CLI 的运行时，避免给生产桌面壳增加浏览器依赖。
const playwrightModule = process.env.AI_ME_PLAYWRIGHT_MODULE;
const { _electron } = await import(
  playwrightModule ? pathToFileURL(playwrightModule).href : "playwright"
);
const root = path.resolve("..");
await mkdir(path.join(root, "tmp"), { recursive: true });
const profile = await mkdtemp(path.join(root, "tmp", "window-chrome-"));
const electron = await _electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: [".", `--user-data-dir=${profile}`],
  cwd: process.cwd(),
});
try {
  const page = await electron.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const controls = page.getByTestId("desktop-window-controls");
  await controls.waitFor({ state: "visible", timeout: 60000 });
  assert.equal(await controls.count(), 1, "只能有一套原版窗口按钮");
  assert.equal(
    await page.evaluate(() =>
      document.documentElement.classList.contains("platform-windows-desktop"),
    ),
    true,
  );

  const maximize = page.getByTestId("window-control-maximize");
  await maximize.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="window-control-maximize"]')
        ?.getAttribute("data-maximized") === "true",
  );
  assert.equal(
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMaximized(),
    ),
    true,
  );
  await maximize.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="window-control-maximize"]')
        ?.getAttribute("data-maximized") === "false",
  );

  await page.getByTestId("window-control-minimize").click();
  // 查询原生状态而非按钮样式，验证 IPC 确实抵达窗口。
  await electron.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    for (let retry = 0; retry < 30 && !window.isMinimized(); retry++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (!window.isMinimized()) throw new Error("窗口没有最小化");
    window.restore();
    window.show();
  });
  await controls.waitFor({ state: "visible" });
  const dragRegions = await page.evaluate(
    () =>
      [...document.querySelectorAll("*")].filter(
        (element) =>
          getComputedStyle(element).getPropertyValue("app-region") === "drag",
      ).length,
  );
  assert.ok(dragRegions > 0, "窗口需要保留原版标题栏拖动区域");
  assert.equal(
    await maximize.evaluate((element) =>
      getComputedStyle(element).getPropertyValue("app-region"),
    ),
    "no-drag",
  );
  await assert.rejects(
    page.evaluate(() =>
      window.aiMeDesktop.executeDesktopCommand("not-a-real-command"),
    ),
    /尚未接入/,
  );

  await mkdir(path.join(root, "output/playwright"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "output/playwright/desktop-window-controls.png"),
  });
  assert.deepEqual(errors, []);
  const closed = page.waitForEvent("close");
  await page.getByTestId("window-control-close").click();
  await closed;
  console.log(
    "原版窗控实测通过：最大化/还原、最小化、关闭、状态同步、拖动区和命令拒绝。",
  );
} finally {
  await electron.close().catch(() => {});
}
