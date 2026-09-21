import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const development = process.argv.includes('--dev');
// 后端与 Electron 共享一次启动的随机令牌，避免浏览器网页调用执行桥。
const env = { ...process.env, AIME_BROWSER_BRIDGE_TOKEN: process.env.AIME_BROWSER_BRIDGE_TOKEN || randomBytes(32).toString('hex') };
delete env.ELECTRON_RUN_AS_NODE;
const api = new URL(env.AI_ME_API_URL || 'http://127.0.0.1:8000');
if (api.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(api.hostname) || api.pathname !== '/' || api.search || api.hash || api.username || api.password) {
  throw new Error('AI_ME_API_URL 必须是本机 HTTP 服务地址');
}
env.AI_ME_API_URL = api.origin;
const children = new Set();
let stopping = false;
function start(command, args, cwd) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  children.add(child);
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => { children.delete(child); if (!stopping) stop(code ?? 1); });
  return child;
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    // Windows 结束启动器拥有的子进程树，防止遗留带旧令牌的后端。
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
async function waitFor(url) {
  for (let retry = 0; retry < 120; retry++) {
    if (stopping) throw new Error('启动已取消');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* 启动期间允许短暂拒绝连接。 */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`启动超时：${url}`);
}
try {
  // .env 由 uv 显式加载；不要把真实密钥写到 package.json 或 renderer。
  const dotenv = path.join(desktop, '../backend/.env');
  start('uv', ['run', ...(existsSync(dotenv) ? ['--env-file', dotenv] : []), '--directory', '../backend', 'uvicorn', 'aime.main:app', '--host', '127.0.0.1', '--port', api.port || '80'], desktop);
  if (development) {
    env.AI_ME_RENDERER_URL = 'http://127.0.0.1:5173';
    const vite = path.join(path.dirname(require.resolve('vite/package.json', { paths: [path.join(desktop, '../frontend')] })), 'bin/vite.js');
    start(process.execPath, [vite, '--host', '127.0.0.1', '--strictPort'], path.join(desktop, '../frontend'));
  }
  await waitFor(`${api.origin}/api/health`);
  if (development) await waitFor(env.AI_ME_RENDERER_URL);
  start(require('electron'), ['.'], desktop);
} catch (error) { console.error(error.message); stop(1); }
