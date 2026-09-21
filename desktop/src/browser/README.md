# Electron 浏览器执行器

```ts
import { BrowserHost } from "./browser/host.js";

const host = new BrowserHost(mainWindow, {
  blockedOrigins: [apiBaseUrl, rendererUrl],
});
host.setViewport({ sessionId, rect: { x: 20, y: 100, width: 900, height: 600 } });
await host.command(sessionId, "navigate", { url: "https://example.com" });
const snapshot = await host.command(sessionId, "observe");
// 后端完成 UI 审批后，将当前 snapshotId/actionId 交给 act。
host.invalidate(sessionId); // stop/manual nav/run 替换/bridge cancel 时同步调用
host.setViewport({ sessionId, rect: null });
host.dispose();
```

## 对接约定

- `command(sessionId, operation, args?: unknown)` 按操作严格检查字段；`navigate` 只接收 `url`，`act` 只接收 `snapshotId/actionId/text?`，其他操作不接收字段。桥接层先校验并剥离 `runId` 等信封信息。
- `state/back/forward/reload/stop/close/navigate` 返回 `BrowserState`；`observe` 返回 `BrowserSnapshot`；`act` 返回 `{ok:true,outcome:'completed'|'uncertain',snapshotId,actionId,state}`。
- 主进程负责校验 IPC 来源、业务会话存在性、runId 和 UI 审批。Host 要求先 `setViewport` 建立可见资格；除 `state/stop/close` 外仅允许当前可见会话操作。可用 `isVisible(sessionId)` 做桥接层检查。
- `browser:state` 事件载荷是 `{sessionId,state}`。关闭页面会发送空状态。rect 使用窗口内容区 DIP 坐标，越界裁剪；A 会话迟到的隐藏请求不影响已经显示的 B。
- 主入口应在开始新 run、用户停止、手动导航及 bridge cancel 时立即调用 `invalidate`。正常导航推进文档 epoch，显式取消推进 cancelVersion。观察只允许跨正常导航重试，10 秒内等待加载；动作永不重试。
- `outcome: 'uncertain'` 表示导航让动作执行回包丢失，副作用可能已经发生。下一步只能重新观察，不能把它当成失败而重复动作。
- 页面隐藏、视口变化会撤销快照。若显式撤销时仍有命令在途，页面会被关闭，以取消无法单独撤回的 CDP 命令；下次 navigate 重新开页。停止并不回滚已经送达网页的副作用。

## 安全与能力边界

每会话一个独立的随机内存 partition，最多保留 8 页。sandbox/contextIsolation 开启、Node 关闭、无 preload；权限和下载全部拒绝，新窗口不会创建，安全 HTTP(S) 链接在当前页打开。

`blockedOrigins` 提取的端口对**所有域名**一律封锁，包括 DNS 映射到本机的域名、回环别名和远程同端口。策略覆盖导航、重定向、子资源 fetch、子框架和 WebSocket。此限制刻意保守；本地 fixture 请使用其他动态端口。若 API 使用 80/443，会相应限制所有同端口网页。

快照在隔离世界的一次同步 DOM 读取中产生；动作保存原始节点引用和已观察的选项，不接收模型 selector/code。执行前比较文档、全部表单状态、位置、遮挡、禁用与连接状态；MutationObserver 捕获发生过又还原的 DOM 变化。密码及密码自动填充字段不生成动作或输出值。快照有效期 60 秒，单次使用。

控件使用 CDP 隔离世界中的受控同步 DOM 操作，以将校验和副作用放入同一调用；fill/select 派发 input/change。依赖 `isTrusted` 的网站可能不接受此类动作。不会自动跨 iframe/Shadow DOM，也不提供任意脚本、文件上传、密码填写或 CSS selector。文档变化采取保守拒绝策略，动态页面可能需要重新观察。

实现参考 Maka WebContentsView 生命周期和隔离边界，结合 snapshot/action 编号思路自主实现；导航事件语义参照 [Electron webContents 文档](https://www.electronjs.org/docs/latest/api/web-contents)。

## 验证

在 desktop 目录运行：

```text
node_modules/.bin/tsc.cmd -p tsconfig.json --noEmit
node src/browser/verify.mjs
```

独立验证器编译本目录到系统临时目录，运行策略测试与真实 Electron HTTP fixture，完成后删除本次临时产物，不修改 package/main/preload。覆盖 DOM/表单陈旧、节点移除/禁用/遮挡、密码过滤、五类动作、延迟导航、取消竞态、会话隔离、权限/下载、应用端口隔离及页面数量/销毁。
