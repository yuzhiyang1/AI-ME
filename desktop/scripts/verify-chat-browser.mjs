/** 从真实聊天 UI 发起，不直接调用 host.tool 或伪造浏览器动作结果。 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve('..');
const runtime = process.env.AI_ME_PLAYWRIGHT_MODULE;
const { _electron } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
await mkdir(path.join(root, 'tmp'), { recursive: true });
await mkdir(path.join(root, 'output/playwright'), { recursive: true });
const sandbox = await mkdtemp(path.join(root, 'tmp/chat-browser-'));
const token = randomBytes(32).toString('hex');
const secret = randomUUID();
let logins = 0;
let records = 0;
const fixture = createServer(async (request, response) => {
  if (request.url === '/login' && request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    const credentials = JSON.parse(body);
    const valid = credentials.user === 'tester' && credentials.password === secret;
    if (valid) logins++;
    response.writeHead(valid ? 200 : 401, valid ? { 'Set-Cookie': 'fixture-session=authenticated; HttpOnly; SameSite=Strict' } : {});
    response.end(valid ? 'Signed in' : 'Denied'); return;
  }
  if (request.url === '/record' && request.method === 'POST') {
    const valid = request.headers.cookie?.includes('fixture-session=authenticated');
    if (valid) records++;
    response.writeHead(valid ? 200 : 401); response.end(valid ? 'Record created: QA-001' : 'Denied'); return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>聊天浏览器登录验收</title><style>body{font:18px system-ui;margin:24px}label,output{display:block;margin:12px 0}input,button{font:inherit;padding:8px}button{margin-right:8px}</style>
    <h1>Local login integration</h1><p>隔离的测试站点，不连接真实业务。</p>
    <label>User<input id="user" autocomplete="off"></label><label>Password<input type="password" id="password" autocomplete="off"></label>
    <button id="login">Login</button><button id="create-record" disabled>Create record</button><output></output>
    <script>document.querySelector('#login').onclick=async()=>{const result=await fetch('/login',{method:'POST',body:JSON.stringify({user:document.querySelector('#user').value,password:document.querySelector('#password').value})});document.querySelector('output').textContent=await result.text();document.querySelector('#create-record').disabled=!result.ok};document.querySelector('#create-record').onclick=async()=>{document.querySelector('output').textContent=await(await fetch('/record',{method:'POST'})).text()};</script>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const backend = spawn(path.join(root, 'backend/.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'browser_chat_acceptance_app:app', '--app-dir', path.join(root, 'backend/tests'), '--host', '127.0.0.1', '--port', String(port)], {
  cwd: path.join(root, 'backend'), windowsHide: true,
  env: { ...process.env, AI_ME_ACCEPTANCE_DIR: sandbox, AI_ME_CHAT_FIXTURE: fixtureUrl, AIME_BROWSER_BRIDGE_TOKEN: token, AIME_SKILL_ROOTS: '' },
});
let log = '';
backend.stderr.on('data', data => { log += data; });
backend.stdout.on('data', data => { log += data; });
let electron, page;
async function until(check, label) {
  for (let count = 0; count < 150; count++) {
    if (await check()) return;
    if (backend.exitCode !== null) throw new Error('验收后端退出');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(label + '超时');
}
async function api(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
}
try {
  await until(async () => { try { return (await fetch(base + '/api/health')).ok; } catch { return false; } }, '后端启动');
  await api('/api/projects', { name: '聊天浏览器验收', roots: [{ path: sandbox }], idempotencyKey: 'chat-browser' });
  electron = await _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['.', `--user-data-dir=${path.join(sandbox, 'profile')}`], cwd: process.cwd(), env: { ...process.env, AI_ME_API_URL: base, AIME_BROWSER_BRIDGE_TOKEN: token, AI_ME_RENDERER_URL: '' } });
  electron.process().stderr.on('data', data => { log += data; });
  page = await electron.firstWindow(); page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('v4-composer-input').fill('导航测试站点并观察登录表单');
  await page.getByTestId('v4-composer-send').click();
  await until(async () => (await api('/api/sessions')).length === 1, '创建聊天');
  const session = (await api('/api/sessions'))[0];
  let approvals;
  await until(async () => { approvals = await api(`/api/sessions/${session.id}/approvals`); return approvals.length > 0; }, '申请站点授权');
  assert.equal(logins, 0);
  assert.equal(approvals[0].toolName, 'browser_navigate');
  await api(`/api/sessions/${session.id}/approvals/${approvals[0].id}/decision`, { decision: 'approve_session' });
  await until(async () => (await api(`/api/sessions/${session.id}`)).activity === 'idle', '导航与观察');
  await page.getByTestId('desktop-browser-panel').waitFor();
  const firstItems = await api(`/api/sessions/${session.id}/items`);
  assert.match(JSON.stringify(firstItems), /已从内置浏览器回读验证/);
  console.log('PASS 聊天发起、站点授权、自动展开、真实网页快照');
  await page.getByTestId('browser-credentials').locator('summary').click();
  await page.getByLabel('凭据内容', { exact: true }).fill(secret);
  await page.getByRole('button', { name: '保存临时凭据', exact: true }).click();
  await page.getByText(/已保存引用 test-password/).waitFor();
  assert.equal(await page.getByLabel('凭据内容', { exact: true }).inputValue(), '');
  await page.getByTestId('browser-credentials').locator('summary').click();
  await page.getByTestId('v4-composer-input').fill('使用 test-password 凭据登录、创建测试记录并回读结果');
  await page.getByTestId('v4-composer-send').click();
  await until(async () => records === 1, '登录后创建记录');
  await until(async () => (await api(`/api/sessions/${session.id}`)).activity === 'idle', '回读验证');
  const items = await api(`/api/sessions/${session.id}/items`);
  assert.match(JSON.stringify(items), /已从内置浏览器回读验证：Record created: QA-001/);
  assert.ok(!JSON.stringify(items).includes(secret));
  assert.equal(logins, 1); assert.equal(records, 1);
  assert.equal((await api(`/api/sessions/${session.id}/approvals`)).length, 0);
  const database = await readFile(path.join(sandbox, 'state/ai-me.db'));
  assert.ok(!database.includes(Buffer.from(secret)), '真实凭据不能进入 SQLite');
  assert.deepEqual(errors, []);
  await page.getByText('已从内置浏览器回读验证：Record created: QA-001', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'output/playwright/chat-browser-login.png') });
  // Playwright 的 renderer 截图不含原生子视图；单独保存真实 guest 的页面证据。
  const guestImage = await electron.evaluate(async ({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url));
    return (await guest.capturePage()).toPNG().toString('base64');
  }, fixtureUrl);
  await writeFile(path.join(root, 'output/playwright/chat-browser-page.png'), Buffer.from(guestImage, 'base64'));
  await writeFile(path.join(root, 'output/playwright/chat-browser-acceptance.json'), JSON.stringify({ passed: ['chat tool loop', 'auto-open visible page', 'site-scoped approval', 'credential IPC without echo', 'real HTTP login and cookie', 'authenticated business action exactly once', 'readback verification', 'no secret in conversation or SQLite'], model: 'deterministic model fixture', logins, records, sandbox }, null, 2));
  console.log('PASS 聊天自动登录、真实 Cookie、受保护操作一次、正文回读、凭据不进聊天/数据库');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(root, 'output/playwright/chat-browser-failure.png') }).catch(() => {}); console.error((await page.locator('body').innerText()).slice(-7000)); }
  console.error(log.slice(-4000)); throw error;
} finally {
  if (electron) await electron.close();
  backend.kill(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
}
