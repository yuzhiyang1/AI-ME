import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { app, BrowserWindow, webContents, type WebContents } from "electron";
import { BrowserHost } from "./host.js";
import type { BrowserSnapshot } from "./types.js";

const errors: unknown[] = [];
process.on("unhandledRejection", (error) => errors.push(error));

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

async function run(): Promise<void> {
  await app.whenReady();
  let blockedRequests = 0;
  const blocked = createServer((_request, response) => { blockedRequests++; response.end("SECRET"); });
  const blockedPort = await listen(blocked);
  const fixture = createServer((request, response) => {
    if (request.url === "/slow") {
      setTimeout(() => { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end("<title>延迟页面</title><p>延迟导航已完成</p>"); }, 450);
      return;
    }
    if (request.url === "/redirect") { response.writeHead(302, { Location: `http://localhost:${blockedPort}/secret` }); response.end(); return; }
    if (request.url === "/download") { response.writeHead(200, { "Content-Disposition": "attachment; filename=test.txt" }); response.end("download"); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><title>测试页面</title></head><body>
      <label>姓名<input id="name" value="初始"></label>
      <label>密码<input type="password" value="DO-NOT-EXPOSE"></label>
      <select id="choice" aria-label="类型"><option value="a">甲</option><option value="b">乙</option><option disabled value="c">禁用</option></select>
      <button id="submit" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">提交</button>
      <button disabled>禁用按钮</button><p id="content">当前可见内容</p>
      <a id="popup" target="_blank" href="/second">新页面</a>
      <a id="slow" href="/slow">延迟导航</a>
      <div style="height:1800px"></div><p>底部内容</p>
    </body></html>`);
  });
  const port = await listen(fixture);
  const origin = `http://127.0.0.1:${port}`;
  // 屏幕外窗口提供真实 native view/DOM hit-test，不占用用户当前工作区。
  const window = new BrowserWindow({ show: false, x: -10000, y: -10000, width: 900, height: 700 });
  window.showInactive();
  const host = new BrowserHost(window, { blockedOrigins: [`http://127.0.0.1:${blockedPort}`] });
  const rect = { x: 0, y: 0, width: 850, height: 620 };
  const contents = (): WebContents => {
    const found = webContents.getAllWebContents().find((wc) => wc.id !== window.webContents.id && wc.getURL().startsWith(origin));
    assert.ok(found, "应存在 fixture 页面");
    return found;
  };
  const snapshot = () => host.command("one", "observe") as Promise<BrowserSnapshot>;
  const execute = async (kind: string, label?: string, text?: string) => {
    const observed = await snapshot();
    const action = observed.actions.find((item) => item.kind === kind && (!label || item.label.includes(label)));
    assert.ok(action, `应观察到 ${kind}/${label}`);
    return host.command("one", "act", { snapshotId: observed.snapshotId, actionId: action.id, ...(text !== undefined ? { text } : {}) });
  };
  try {
    await assert.rejects(host.command("unknown", "navigate", { url: origin }), /可见/);
    host.setViewport({ sessionId: "one", rect });
    await host.command("one", "navigate", { url: origin });
    const wc = contents();
    assert.equal(await wc.executeJavaScript("typeof require + ':' + typeof process + ':' + typeof window.electron"), "undefined:undefined:undefined");
    assert.equal(wc.session.isPersistent(), false);

    const first = await snapshot();
    assert.ok(first.text.includes("当前可见内容"));
    assert.ok(!JSON.stringify(first).includes("DO-NOT-EXPOSE"));
    assert.ok(!first.actions.some((action) => action.label.includes("密码") || action.label === "禁用按钮"));
    await execute("fill", "姓名", "张三");
    assert.equal(await wc.executeJavaScript("document.querySelector('#name').value"), "张三");
    await execute("select", "乙");
    assert.equal(await wc.executeJavaScript("document.querySelector('#choice').value"), "b");
    await execute("click", "提交");
    assert.equal(await wc.executeJavaScript("document.querySelector('#submit').dataset.clicks"), "1");
    await assert.rejects(host.command("one", "act", { snapshotId: first.snapshotId, actionId: first.actions[0]!.id }), /失效/);
    console.log("PASS 原子快照、密码过滤、fill/select/click、单次消费");

    await execute("scroll", "向下");
    assert.ok(await wc.executeJavaScript("scrollY > 0"));
    await execute("wait");
    await execute("scroll", "向上");
    const tokenBeforeStop = await snapshot();
    await host.command("one", "stop");
    await assert.rejects(host.command("one", "act", { snapshotId: tokenBeforeStop.snapshotId, actionId: "1" }), /失效/);
    await assert.rejects(host.command("one", "act", { snapshotId: "x", actionId: "1", selector: "#submit" }), /未允许/);
    const concurrentObservation = snapshot();
    await assert.rejects(snapshot(), /正在执行/);
    await concurrentObservation;
    console.log("PASS scroll/wait、stop 撤销、selector 注入拒绝、并发 fail-closed");

    for (const mutation of [
      "document.querySelector('#content').textContent='changed'",
      "document.querySelector('#name').value='programmatic change'",
      "document.querySelector('#submit').disabled=true",
      "document.querySelector('#submit').remove()",
      "document.body.insertAdjacentHTML('beforeend', '<div style=\"position:fixed;inset:0;z-index:999;background:white\">遮挡</div>')",
    ]) {
      await host.command("one", "navigate", { url: origin });
      const observed = await snapshot();
      const click = observed.actions.find((action) => action.label === "提交")!;
      await contents().executeJavaScript(mutation);
      await assert.rejects(host.command("one", "act", { snapshotId: observed.snapshotId, actionId: click.id }), /变化|移除|禁用|遮挡/);
    }
    console.log("PASS DOM/表单变化、禁用、移除、遮挡均拒绝旧动作");

    await host.command("one", "navigate", { url: origin });
    const beforeHidden = await snapshot();
    host.setViewport({ sessionId: "one", rect: null });
    await assert.rejects(snapshot(), /可见/);
    host.setViewport({ sessionId: "one", rect });
    await assert.rejects(host.command("one", "act", { snapshotId: beforeHidden.snapshotId, actionId: "1" }), /失效/);
    const beforeStop = await snapshot();
    host.invalidate("one");
    await assert.rejects(host.command("one", "act", { snapshotId: beforeStop.snapshotId, actionId: "1" }), /失效/);
    const pendingObserve = snapshot();
    host.invalidate("one");
    await assert.rejects(pendingObserve);
    assert.equal((await host.command("one", "state") as { hasPage: boolean }).hasPage, false);
    await host.command("one", "navigate", { url: origin });
    console.log("PASS 隐藏/stop 同步撤销及在途 observe 取消");

    await execute("click", "延迟导航");
    const afterDelayedNavigation = await snapshot();
    assert.ok(afterDelayedNavigation.text.includes("延迟导航已完成"));
    await host.command("one", "navigate", { url: origin });
    await execute("click", "延迟导航");
    const waiting = snapshot();
    setTimeout(() => host.invalidate("one"), 40);
    await assert.rejects(waiting, /隐藏|关闭|撤销/);
    await host.command("one", "navigate", { url: origin });
    console.log("PASS click 延迟导航后 observe 等待成功，等待期间 cancel 终止且旧页不伤及重开页");

    await assert.rejects(host.command("one", "navigate", { url: `http://127.1:${blockedPort}/` }), /禁止/);
    const fetchDenied = await contents().executeJavaScript(`fetch('http://localhost:${blockedPort}/secret').then(()=>false,()=>true)`);
    assert.equal(fetchDenied, true);
    const wsDenied = await contents().executeJavaScript(`new Promise(resolve=>{const ws=new WebSocket('ws://127.0.0.1:${blockedPort}/'); ws.onerror=()=>resolve(true); ws.onopen=()=>resolve(false);})`);
    assert.equal(wsDenied, true);
    await assert.rejects(host.command("one", "navigate", { url: `${origin}/redirect` }), /失败/);
    assert.equal(blockedRequests, 0);
    await host.command("one", "navigate", { url: origin });
    console.log("PASS API 端口 navigate/fetch/WebSocket/redirect 阻断，其他动态端口通过");

    const permissionsDenied = await contents().executeJavaScript("navigator.permissions.query({name:'geolocation'}).then(value=>value.state)");
    assert.equal(permissionsDenied, "denied");
    const beforePopup = webContents.getAllWebContents().length;
    await execute("click", "新页面");
    assert.equal((await snapshot()).url, `${origin}/second`);
    assert.equal(webContents.getAllWebContents().length, beforePopup);
    await host.command("one", "back");
    assert.equal((await snapshot()).url, `${origin}/`);
    await host.command("one", "forward");
    assert.equal((await snapshot()).url, `${origin}/second`);
    await host.command("one", "reload");
    await snapshot();
    const countBeforeUnsafePopup = webContents.getAllWebContents().length;
    await contents().executeJavaScript("window.open('file:///C:/Windows/win.ini'); undefined");
    assert.equal(webContents.getAllWebContents().length, countBeforeUnsafePopup);
    await assert.rejects(host.command("one", "navigate", { url: `${origin}/download` }), /失败/);
    await host.command("one", "navigate", { url: origin });
    console.log("PASS 权限拒绝、popup 本页打开及非 HTTP 拒绝、back/forward/reload、下载拒绝");

    const oldSession = contents().session;
    await oldSession.cookies.set({ url: origin, name: "isolation", value: "one" });
    host.setViewport({ sessionId: "two", rect });
    await host.command("two", "navigate", { url: `${origin}/two` });
    const secondContents = webContents.getAllWebContents().find((item) => item.getURL() === `${origin}/two`)!;
    assert.notEqual(secondContents.session, oldSession);
    assert.equal((await secondContents.session.cookies.get({ name: "isolation" })).length, 0);
    await assert.rejects(host.command("one", "observe"), /可见/);
    host.setViewport({ sessionId: "one", rect: null });
    assert.equal(host.isVisible("two"), true);

    for (let index = 3; index <= 8; index++) {
      const id = String(index);
      host.setViewport({ sessionId: id, rect });
      await host.command(id, "navigate", { url: `${origin}/${index}` });
    }
    host.setViewport({ sessionId: "nine", rect });
    await assert.rejects(host.command("nine", "navigate", { url: origin }), /最多/);
    await host.command("two", "close");
    await host.command("nine", "navigate", { url: origin });
    console.log("PASS 会话 partition/cookie 隔离、迟到隐藏、8 页限制及关闭释放");
    host.dispose();
    host.dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(webContents.getAllWebContents().filter((item) => item.id !== window.webContents.id).length, 0);
    assert.deepEqual(errors, []);
    console.log("PASS 全部页面销毁，无 unhandled rejection");
  } finally {
    host.dispose();
    window.destroy();
    fixture.closeAllConnections();
    blocked.closeAllConnections();
    fixture.close();
    blocked.close();
  }
}

void run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
