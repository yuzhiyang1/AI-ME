# 桌面浏览器与 Jev 前端接入

## 入口与现有工作台

真实入口为工作台右上角 **展开侧边面板 → 浏览器**；已有侧栏时使用 **新增标签 → 浏览器**。
不是 Header 中未启用的「切换浏览器」按钮。继续沿用 ZCode 的标签页、拖拽分栏、Button、Input 和主题变量，没有 iframe。

`main.jsx` 仅在桌面身份及 `command/setViewport/onState/run` 四个方法全部可用时启用 `supportsEmbeddedBrowser`，并传入可选的 `hostBrowserPane`。不传此属性的 Root 仍使用原浏览器。侧栏关闭绕过上游 logical-tab 协议，由宿主面板释放原生页面。

同一 workspace/owner 的重复入口与网页链接复用浏览器标签。只有当前可见标签挂载页面控制器；每会话一页，不创建多个 viewport。

## 真实会话选择

`services.taskMeta` 将后端 `session.id` 原样映射为 `taskId`。

1. 活动窗口标签必须是 workspace；设置页返回空会话并清理运行。
2. 有活动 workbench group 时，使用该 group 的焦点 pane binding（primary 使用 primaryBinding）。
3. 无 group 的次分屏使用 `usePaneLayoutStore` 中焦点 pane 的 sessionId。
4. 普通主面板使用活动 workspace 对应的 `useZCodeSessionStore.workspaces[key].activeTaskId`。

不等待 taskListCache、不使用 draftSessionId、不将项目路径当 sessionId。草稿、只读或未验证的恢复分屏不允许启动。切换会话会重新挂载任务表单，逐步确认恢复为 true。

## bridge 契约

完整类型在 `src/desktop.d.ts`。前端只调用 `window.aiMeDesktop.browser`：

- `command(sessionId, operation, args)`：navigate/back/forward/reload/stop/close/state；navigate 使用 `{url}`。返回页面状态 `{url,title,canGoBack,canGoForward,loading,hasPage}`。
- `setViewport({sessionId,rect})`：rect 是 renderer CSS 像素 `{x,y,width,height}`，由 Electron 根据 zoom 转换；null 撤下原生层。首次空页也提交有效 rect，使 navigate 可以获得可见资格。
- `onState(callback)`：按 `{sessionId,state}` 过滤，返回取消订阅函数。
- `run('', 'config', {})`：返回 `{configured,model,textConfigured,bridgeConnected}`。面板每 3 秒及窗口重新聚焦时刷新，避免初次未连接后永久禁用。
- `run('', 'configure', {apiKey?,model,clearApiKey?})`：保存 Jev 配置并返回配置状态。默认模型为 `jev-latest`。密码提交后立即清空，不存入 localStorage，也不回显；后端负责 keyring。留空保留已有密钥，勾选清除才传 clearApiKey。
- `run(sessionId, 'start', {goal,maxSteps:20,confirmEachAction})`：逐步确认默认 true；用户主动取消仅影响本次任务。普通文字模型沿用后端默认选择，不额外索要密钥，也不擅自选择 textModelRef。
- `run(sessionId, 'current', {})`：返回运行或 null。前端每次请求完成后隔 1 秒再请求，无请求重叠。
- `run(sessionId, 'revoke', {})`：立即发 IPC 撤销执行授权，不进入网络队列。stop/dispose 均先撤销，随后等待已有 start 返回，再 current + stop。
- `run(sessionId, 'stop', {runId})`：停止后台运行。
- `run(sessionId, 'approve', {runId,approve,approvalId})`：允许/拒绝均携带当前 pendingAction.approvalId，旧 ID 由后端拒绝。

相比最初契约，新增 configure/revoke、bridgeConnected 和 approvalId，confirmEachAction 改为任务级 boolean。没有新增运行推送事件，仍通过 current 轮询。

折叠、切会话、进入设置时撤下 viewport 并停止任务；标签真正关闭时再 command close。模态框、菜单和弹出层出现时撤下 viewport，消失后恢复。底部操作区固定 280px（短窗口上限 55%）并内部滚动，审批与步骤增多不改变页面区域高度。页面标题单行，URL 编辑期间不会被加载状态事件覆盖。

## Electron 验收定位

| 用途 | 稳定定位 |
| --- | --- |
| 空侧栏打开浏览器 | `data-testid="browser-open-launcher"`，label「浏览器」 |
| 新增标签菜单 | `data-testid="browser-open-menu-item"`，label「浏览器」 |
| 面板及会话 | `desktop-browser-panel`，`data-session-id` 为真实后端 ID |
| 网页地址 | `browser-address`，label「网页地址」 |
| 地址操作 | labels「后退」「前进」「刷新」「停止加载」「前往」「关闭浏览器」 |
| 原生页面占位 | `native-browser-viewport` |
| 固定底部区域 | `browser-run-footer` |
| 目标与逐步确认 | `jev-goal`、`jev-confirm-each-action` |
| 启停与状态 | `jev-start`、`jev-stop`、`jev-run-status` |
| 待审批操作 | `jev-pending-action`，`data-approval-id` 为当前审批 UUID |
| 审批按钮 | `jev-approve`、`jev-reject` |
| 步骤列表 | `jev-steps` |
| 跳转模型配置 | `jev-open-settings` |
| Jev 设置 | `jev-settings`、`jev-model`、`jev-api-key`、`jev-config-status`、`jev-clear-key`、`jev-save` |

连续审批必须等待 DOM 中的 data-approval-id 改变后再点击。页面首次导航在 rect 已提交后执行；启动按钮要求已有网页且加载完成。

前端窄集成用例：`npm test -- src/workbench/browser-panel.test.jsx src/workbench/local-models.test.jsx src/workbench/desktop-platform.test.js`。jsdom 验证协议与生命周期，不替代真实 Electron 原生层定位和截图验收。
