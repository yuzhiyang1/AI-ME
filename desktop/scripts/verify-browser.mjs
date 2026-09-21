/** 真实桌面验收：仅替换模型，HTTP/WebSocket/DOM/审批和 SQLite 都真实执行。 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve('..');
const runtime = process.env.AI_ME_PLAYWRIGHT_MODULE;
const { _electron } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
await mkdir(path.join(root, 'tmp'), { recursive: true });
await mkdir(path.join(root, 'output/playwright'), { recursive: true });
const sandbox = await mkdtemp(path.join(root, 'tmp/browser-'));
const token = randomBytes(32).toString('hex');
const fixture = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="en"><title>AI-ME Browser Acceptance</title>
    <style>body{font:18px system-ui;margin:28px;color:#20252b;background:#f8fafc}input,button{padding:10px;font:inherit}button{background:#6d5bd0;color:white;border:0;border-radius:6px}label{display:block;margin-bottom:8px}output{display:block;margin-top:20px}</style>
    <h1>Browser Search</h1><p>This page is a local acceptance fixture.</p>
    <form><label for="query">Search</label><input id="query" name="query" autocomplete="off"><button type="submit">Search</button></form>
    <output></output><script>document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();document.querySelector('output').textContent='Found: '+document.querySelector('input').value})</script></html>`);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const backend = spawn(path.join(root, 'backend/.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'browser_acceptance_app:app', '--app-dir', path.join(root, 'backend/tests'), '--host', '127.0.0.1', '--port', String(port)], {
  cwd: path.join(root, 'backend'), windowsHide: true, env: { ...process.env, AI_ME_ACCEPTANCE_DIR: sandbox, AIME_BROWSER_BRIDGE_TOKEN: token, AIME_SKILL_ROOTS: '' },
});
let log = '';
backend.stderr.on('data', (data) => { log += data; });
backend.stdout.on('data', (data) => { log += data; });
let electron;
let page;
const evidence = [];
async function until(check, label = '等待条件') {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    if (backend.exitCode !== null) throw new Error(`后端已退出：${log}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label}超时`);
}
async function api(route, body, authenticated = false) {
  const result = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: {
    'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(result.ok, `${route}: ${result.status} ${await (!result.ok ? result.text() : Promise.resolve(''))}`);
  return result.json();
}
try {
  await until(async () => { try { return (await fetch(base + '/api/health')).ok; } catch { return false; } }, '后端启动');
  await api('/api/projects', { name: '浏览器验收', roots: [{ path: sandbox }], idempotencyKey: 'browser-test' });
  electron = await _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['.', `--user-data-dir=${path.join(sandbox, 'profile')}`], cwd: process.cwd(), env: {
    ...process.env, AI_ME_API_URL: base, AIME_BROWSER_BRIDGE_TOKEN: token, AI_ME_RENDERER_URL: '',
  } });
  page = await electron.firstWindow();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByTestId('v4-composer-input').fill('创建浏览器验收会话');
  await page.getByTestId('v4-composer-send').click();
  await until(async () => (await api('/api/sessions')).length === 1, '创建会话');
  const session = (await api('/api/sessions'))[0];

  await page.getByTestId('task-settings-button').click();
  await page.getByTestId('settings-section-nav-modelProvider').click();
  await page.getByTestId('jev-api-key').fill('acceptance-not-a-real-secret');
  await page.getByTestId('jev-save').click();
  await page.getByText('Jev 配置已保存', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('jev-api-key').inputValue(), '');
  const config = await api('/api/browser/config', undefined, true);
  assert.equal(config.configured, true);
  assert.ok(!JSON.stringify(config).includes('acceptance-not-a-real-secret'));
  await page.screenshot({ path: path.join(root, 'output/playwright/jev-settings.png') });
  evidence.push('设置保存后不回显密钥');
  await page.getByTestId('settings-back-button').click();
  await page.getByRole('button', { name: '展开侧边面板', exact: true }).click();
  await page.locator('[data-side-pane-open-tab-item="browser"]').click();
  const panel = page.getByRole('region', { name: '内置浏览器', exact: true });
  await panel.getByRole('textbox', { name: '网页地址' }).fill(fixtureUrl);
  await panel.getByRole('button', { name: '前往', exact: true }).click();
  await until(async () => (await page.evaluate((id) => window.aiMeDesktop.browser.command(id, 'state'), session.id)).hasPage, '加载内置网页');
  await panel.getByLabel('Jev 浏览器目标', { exact: true }).fill('Search for Jev browser test');
  await panel.getByRole('button', { name: '启动 Jev', exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await panel.getByRole('button', { name: '允许', exact: true }).waitFor();
    const pending = await api(`/api/browser/sessions/${session.id}/runs/current`, undefined, true);
    await panel.getByRole('button', { name: '允许', exact: true }).click();
    if (i === 0) await until(async () => {
      const run = await api(`/api/browser/sessions/${session.id}/runs/current`, undefined, true);
      // 等待渲染层也切到新审批，避免后端已推进但按钮仍绑定旧审批 ID。
      return run.status === 'awaiting_approval'
        && run.pendingAction?.approvalId !== pending.pendingAction?.approvalId
        && await page.getByTestId('jev-pending-action').getAttribute('data-approval-id') === run.pendingAction?.approvalId;
    }, '下一动作');
  }
  await until(async () => (await api(`/api/browser/sessions/${session.id}/runs/current`, undefined, true)).status === 'needs_verification', '完成浏览器任务');
  const observed = await electron.evaluate(async ({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(url));
    return guest?.executeJavaScript('document.querySelector("output").textContent');
  }, fixtureUrl);
  assert.equal(observed, 'Found: Jev browser test', '必须检查真实页面结果，而非仅信任模型 DONE');
  evidence.push('真实同页填写、点击、逐步确认、独立读取结果');
  await until(async () => (await page.getByTestId('jev-run-status').innerText()).includes('需要验证'), '界面终态');
  await page.getByTestId('browser-run-footer').evaluate((element) => { element.scrollTop = 0; });
  // Playwright 的 Page 截图仅含 renderer，不包含原生 WebContentsView。
  // 捕获整个 Electron 窗口才能核对用户看到的网页与工作台布局。
  const windowCapture = await electron.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
    const main = BrowserWindow.getAllWindows()[0];
    const [width, height] = main.getSize();
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
    const source = sources.find((item) => item.id === main.getMediaSourceId());
    if (!source || source.thumbnail.isEmpty()) throw new Error('无法捕获桌面窗口');
    return source.thumbnail.toPNG().toString('base64');
  });
  await writeFile(path.join(root, 'output/playwright/jev-browser.png'), Buffer.from(windowCapture, 'base64'));

  // 未认证请求不能调用浏览器配置或建立控制面；内置网页也不能触达后端。
  assert.equal((await fetch(base + '/api/browser/config')).status, 401);
  const blocked = await electron.evaluate(async ({ webContents }, { url, apiBase }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(url));
    return guest.executeJavaScript(`fetch(${JSON.stringify(apiBase + '/api/health')}).then(()=>false).catch(()=>true)`);
  }, { url: fixtureUrl, apiBase: base });
  assert.equal(blocked, true);
  evidence.push('内置网页访问后端被阻止，控制面无令牌拒绝');

  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await panel.getByRole('button', { name: '启动 Jev', exact: true }).click();
  await panel.getByRole('button', { name: '允许', exact: true }).waitFor();
  await panel.getByRole('button', { name: '停止运行', exact: true }).click();
  await until(async () => (await api(`/api/browser/sessions/${session.id}/runs/current`, undefined, true)).status === 'stopped', '停止任务');
  evidence.push('等待审批时停止，不再输入或点击');
  await until(async () => (await page.getByTestId('jev-run-status').innerText()).includes('已停止'), '界面停止状态');
  await page.getByTestId('jev-confirm-each-action').uncheck();
  await page.getByTestId('jev-start').click();
  await until(async () => (await api(`/api/browser/sessions/${session.id}/runs/current`, undefined, true)).status === 'needs_verification', '自动执行任务');
  assert.equal(await page.getByTestId('jev-pending-action').count(), 0);
  evidence.push('关闭逐步确认后自动完成搜索');

  await until(async () => (await page.getByTestId('jev-run-status').innerText()).includes('需要验证'), '自动执行界面终态');
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByTestId('jev-confirm-each-action').check();
  await page.getByTestId('jev-start').click();
  await page.getByTestId('jev-approve').waitFor();
  await page.getByRole('button', { name: '收起侧边面板', exact: true }).click();
  await until(async () => (await api(`/api/browser/sessions/${session.id}/runs/current`, undefined, true)).status === 'stopped', '收起面板停止');
  evidence.push('收起面板撤销待确认任务');
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, 'output/playwright/browser-acceptance.json'), JSON.stringify({ passed: evidence, model: 'deterministic substitute; no real Jev call', sandbox }, null, 2));
  console.log(JSON.stringify({ passed: evidence, sandbox }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(root, 'output/playwright/browser-failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(-9000));
  }
  console.error(log.slice(-5000));
  throw error;
} finally {
  if (electron) await electron.close();
  backend.kill();
  await new Promise((resolve) => fixture.close(resolve));
}
