import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { app, BrowserWindow, webContents } from 'electron';
import { BrowserHost } from './host.js';
import { BrowserCredentials } from './credentials.js';

/** 真实 Electron + OpenCLI：不调用宿主 DOM 执行器代替待验收的六类工具。 */
async function run() {
await app.whenReady();
const secret = randomUUID();
const fixture = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(`<title>Login fixture</title><style>body{margin:30px}label{display:block;margin:20px 0}input,button{padding:10px}</style><label>User<input id="user"></label>
    <label>Password<input type="password" id="password"></label>
    <button id="login">Login</button><output></output><script>
    document.querySelector('#login').onclick=()=>{document.querySelector('output').textContent=document.querySelector('#password').value===${JSON.stringify(secret)}?'Signed in':'Denied'};
    </script>`);
});
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const window = new BrowserWindow({ show: false, width: 900, height: 700 });
window.showInactive();
const host = new BrowserHost(window);
const credentials = new BrowserCredentials();
const tool = async (name: string, args = {}) => {
  console.log(`RUN OpenCLI ${name}`);
  return host.tool('one', name, origin, args, key => credentials.resolve('one', key, origin));
};
try {
  host.setViewport({ sessionId: 'one', rect: { x: 0, y: 0, width: 800, height: 600 } });
  await tool('navigate', { url: origin });
  const snapshot = await tool('snapshot');
  assert.match(String(snapshot.snapshot), /Password/);
  await tool('type', { ref: '#user', text: 'tester' });
  credentials.save('one', { name: 'test-password', origin, value: secret });
  assert.throws(() => credentials.resolve('other', 'test-password', origin));
  assert.throws(() => credentials.resolve('one', 'test-password', 'https://elsewhere.example'));
  const filled = await tool('type', { ref: '#password', credential: 'test-password' });
  assert.equal(filled.verified, true);
  assert.ok(!JSON.stringify(filled).includes(secret));
  assert.ok(!JSON.stringify(await tool('snapshot')).includes(secret));
  await tool('click', { ref: '#login' });
  const guest = webContents.getAllWebContents().find(wc => wc.getURL().startsWith(origin))!;
  await tool('wait', { text: 'Signed in' });
  assert.match(String((await tool('extract')).text), /Signed in/);
  assert.ok(!JSON.stringify(await tool('extract')).includes(secret));
  // 错误密码不会被“已填写/已点击”误判为登录成功。
  await tool('type', { ref: '#password', text: 'invalid-test-value' });
  await tool('click', { ref: '#login' });
  assert.match(String((await tool('extract')).text), /Denied/);
  assert.ok(!String((await tool('extract')).text).includes('Signed in'));
  await assert.rejects(host.tool('one', 'snapshot', 'https://elsewhere.example', {}, () => ''), /跨站/);
  await assert.rejects(tool('wait', { text: 'never-appears', timeout: 0.1 }));
  // Jev 与 OpenCLI 可轮流使用 debugger，同一时刻仍互斥。
  await host.command('one', 'observe');
  await tool('snapshot');
  const pending = tool('wait', { text: 'never-appears', timeout: 10 });
  await new Promise(resolve => setTimeout(resolve, 100));
  host.invalidate('one');
  await assert.rejects(pending);
  // Electron 的 close 会异步发 destroyed，不能把已撤销误判为必须同步销毁。
  for (let count = 0; count < 50 && !guest.isDestroyed(); count++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(webContents.getAllWebContents().filter(wc => wc.getURL().startsWith(origin)).length, 0);
  console.log('PASS OpenCLI 六工具、密码输入/脱敏、站点与会话隔离、等待失败、Jev 切换、取消');
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  host.dispose(); window.destroy(); credentials.clear(); fixture.closeAllConnections();
  await new Promise<void>(resolve => fixture.close(() => resolve()));
  app.exit(process.exitCode ? 1 : 0);
}
}
void run().catch(error => { console.error(error); app.exit(1); });
