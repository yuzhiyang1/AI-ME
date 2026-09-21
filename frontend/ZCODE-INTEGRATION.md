# ZCode 原版工作台接入状态

## 当前入口

`index.html` → `src/workbench/main.jsx` → vendored `Root` → 原版 `App / WorkspaceShellLayout / SessionPane`。

后端仍是 AI-ME Python/FastAPI，没有启动或移植 ZCode 的 Node Agent 后端。适配器通过现有 `/api` 接口投影原版协议。新增配置时密钥只在表单内存和提交请求中短暂存在，后端不回传、不写入模型投影和浏览器持久存储。

## 已验证（2026-09-21）

- 原版工作台、侧栏、新建任务编辑器和模型选择器实际加载，不再使用旧 AI-ME 自绘首页。
- 在真实浏览器从原版输入框发送纯文本，AI-ME 模型返回“连接成功。”；消息与上下文用量均在原版 UI 展示。
- 刷新后从侧栏打开已持久化测试会话，恢复原回复；数据库无时区时间按 UTC 解析后显示本地时间。
- 36 个前端用例通过，含 10 个适配用例：时间、模型提交门禁、稳定行 ID、错误投影、审批映射、未支持能力拒绝、创建去重、附件拒绝、退订清理，以及 ANSI 查看器依赖兼容。
- 同一会话续聊第二轮返回“第二轮成功。”，侧栏活动时间和用量更新；无浏览器错误，Git 宿主尚未接通的警告仍会显示。
- 生产构建和 Electron 主进程/沙箱预加载构建通过。当前主 JS 约 8.8 MB，存在大包警告，性能优化未完成。
- 已在 `http://127.0.0.1:8000/app/` 验证桌面使用的同一份生产资源：原版首页加载、从侧栏恢复两轮对话正常，许可证 URL 返回 200 且 SHA-256 与上游完全一致。
- npm 官方依赖审计为 0 漏洞；通过 overrides 将 ansi-to-react 间接依赖 linkify-it 更新至 6.1.0，保留 ANSI/链接渲染回归测试。
- 上游 LICENSE、NOTICE、THIRD-PARTY-NOTICES 保存在源码及 public/third-party/zcode，后者自动进入构建目录。

## 文件差异增量交付（2026-09-21）

- `write_file` 新增/覆盖、`edit_file` 精确替换现在会将本次差异写入工具结果账本，经 AI-ME 适配层转换为原版 `file_diff`。工具卡片显示增删行数，点击文件名打开原版红绿差异预览。
- 差异基线是本次工具执行前的文件，不是 Git HEAD；历史查看不重读当前文件。API 集成测试验证了新增、覆盖、编辑、审批、重启恢复及后续手工修改不污染历史。
- 展示差异不传入模型上下文。当前仅覆盖上述内置文件工具；PowerShell/外部程序修改、Git 全局变更面板、回滚及“查看源码”仍不属于这次交付。
- 老记录未保存差异时不能追溯补齐；单侧文本超过 200,000 UTF-8 字节、4,000 行或非文本内容时明确提示不可预览，不截断后伪装完整结果。
- 已通过真实模型调用和生产页面验收：`tmp/file-diff-acceptance-20260921/diff-demo.py` 新增后将 `before` 改成 `after`，卡片显示 `+1 / -1`，点击后展示红绿差异，后端重启后仍可恢复。截图：`output/playwright/file-diff-verified.png`。
- 新增 11 个前端差异用例，前端合计 47 个用例通过；后端全量 95 个通过、1 个环境相关跳过，覆盖新增差异边界与真实 HTTP 持久化测试。4 个本次后端源文件通过 mypy，生产构建通过（仍有既有大包警告）。操作路径：打开测试会话 → 展开“已处理” → 点击第二条 `diff-demo.py`。

## Windows 标题栏增量交付（2026-09-21）

Windows 标题栏已补接：桌面壳使用无边框窗口，原版 `DesktopWindowControls` 负责绘制按钮；窗口状态、最小化、最大化/还原、关闭、全屏、缩放和新建任务/打开工作区命令通过受限 preload 桥接。普通浏览器与其他平台不启用此次 Windows 身份标记。

2026-09-21 已用独立 Electron 实例点击验证最大化/还原、最小化、关闭，确认最大化图标状态同步、页面无未捕获异常。标题栏 drag/no-drag 区域已检查，原生鼠标拖拽因 Computer Use 通道不可用尚未做实机自动化。截图：`output/playwright/desktop-window-controls.png`。前端 50 个用例通过，桌面构建通过；`desktop/scripts/verify-window-chrome.mjs` 可复验（需安装 Playwright，或将 `AI_ME_PLAYWRIGHT_MODULE` 指向现有 Playwright 的 `index.mjs`）。

## 本地模型与账号移除（2026-09-21）

- 运行客户端移除 ZCode 登录/退出、账号恢复与 OAuth 轮询、套餐摘要、升级购买弹窗和商业额度升级提示。侧栏显示“AI-ME · 本地模式”，主题、语言、界面模式、缩放仍使用原版组件。
- “设置 → 模型设置”与模型选择器的“管理模型”均进入 AI-ME 本地表单，复用原有 `/api/settings/models` 与 `/api/models`。支持 DeepSeek/OpenAI/Anthropic/兼容接口预设，新增后同步通知原版模型目录和 V4 工作区配置，无需重启。保留已有模型与密钥，不调用 ZCode 账号后端。
- 保存成功后清空表单密钥；写入成功但目录刷新失败单独提示，避免重复新增；等待启动旧读取完成后再读取提交后的目录，避免旧响应覆盖新模型。没有工作区时进入本地初始配置与目录选择，保留 Windows 原版窗控。
- 构建别名替换账号/购买模块，同时校验最终包不得包含原登录页、OAuth hook、购买弹窗；移除 AI-ME 的 Stripe 安装依赖。vendored 源码、许可证与版权声明保留作来源记录，不代表启用上游账号产品。
- 最终前端 58 项测试通过；后端模型配置/模型 API 定向 9 项测试通过（隔离状态目录与测试凭据存储）；生产构建与账号模块拦截检查通过。
- `desktop/scripts/verify-local-models.mjs` 的真实 Electron 验收通过：本地菜单无登录购买入口、读取现有配置、保存失败后重试、密钥清空、下拉模型即时刷新、管理模型导航、空数据首次使用与窗控。保存部分使用 HTTP 拦截的内存夹具，没有写入用户系统密钥或污染生产模型；实际后端持久化由上述 API 测试验证。无页面未捕获异常，未观察到外部账号/订阅请求。
- 桌面截图：`output/playwright/desktop-local-model-settings.png`、`output/playwright/desktop-local-first-run.png`。复验：在 desktop 设置 `AI_ME_PLAYWRIGHT_MODULE` 为已有 Playwright 的 `index.mjs`，运行 `npm run test:local-models`。

## 尚未完成，不能据此宣称全功能移植

- Git、文件树/预览、终端、附件、自动化、插件/Skill/MCP 管理、子任务、分享、远程连接：原版组件保留，但对应宿主 API 未接通。未实现的调用会明确失败。
- 模型配置已支持原有 AI-ME 的读取/新增与实时启用；编辑、删除不是原有 API 的能力，本次未新增这些接口。
- 当前只支持 `build`（变更前确认）模式；计划、YOLO、既有会话切换模型不会被静默接受。
- 会话变化暂用 1 秒权威快照轮询，尚未将 SSE 文本增量映射成逐 token 帧。停止和审批已有适配与单元测试，尚待真实工具流程验收。
- 同页面同 commandId 的创建去重已覆盖；跨页面重启的会话创建幂等恢复、网络中断完整恢复仍需后端合同补齐。
- 品牌文案大部分保持上游 ZCode 原文，尚未做系统性 AI-ME 品牌替换。
- 宿主适配使用 JavaScript：生产打包和协议 schema 测试已覆盖，不等于完成整个上游源码的 TypeScript 检查。

## 测试方法

沿用仓库根 README 的桌面启动方式。开发浏览器方式：分别在 backend 运行 `uv run uvicorn aime.main:app --host 127.0.0.1 --port 8000`，在 frontend 运行 `npm run dev -- --host 127.0.0.1`，打开 `http://127.0.0.1:5173/`。

桌面生产渲染 `/app/` 使用 frontend/dist，源码变化后必须执行 `npm run build`；仅刷新旧客户端不会替换旧构建。

验收截图位于仓库忽略目录 `output/playwright/`。构建和测试结果应在最终修改后复核，不能把旧 App 的测试当作原版所有功能验收。
