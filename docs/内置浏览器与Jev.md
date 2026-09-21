# 内置浏览器与 Jev

AI-ME 在会话工作台内承载独立网页。用户看到的页面与浏览器任务操作的页面是同一个 Electron `WebContentsView`。每个会话拥有独立浏览器存储，不使用用户日常 Chrome 的登录资料。

## 职责与参考来源

```text
React 工作台：浏览器导航、目标、进度、动作确认
    ↓ 受限 preload IPC
Electron 主进程：WebContentsView、DOM 观察、动作执行
    ↕ 经过随机令牌认证的本机 WebSocket
Python 应用用例：任务循环、取消、步骤记录
    ├─ TypeSafe Jev：在已观察到的动作和元素中选择
    └─ 现有模型网关：生成输入框所需的文字
```

浏览器生命周期和原生视图布局参考 Maka 的 `apps/desktop/src/main/browser/` 与 `browser-panel.tsx`；动作选择参考 [Jev-ultrafast](https://github.com/browser-use/jev-ultrafast)。本实现使用 AI-ME 自己的会话、端口与适配器，不连接该项目默认使用的外部 Chrome，也不启动 Browser Harness 守护进程。

TypeSafe 接口按 [Jev-ultrafast 的调用代码](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/model.py)对接 `/v1/systemone`。一次请求包含动作选择与各动作对应的目标选择，执行时只采用选中动作的目标。校验候选集合、概率归一化、最大概率选项和置信度，模型输出不能成为 JavaScript、选择器或任意坐标。

## 启动和配置

在 `desktop` 目录执行：

```powershell
npm run dev
```

启动器会同时启动 Python 后端、前端开发服务与 Electron，并为本次启动生成执行桥令牌。生产预览先 `npm run build`，再 `npm start`。单独启动 Electron 和后端时，两个进程必须配置相同的 `AIME_BROWSER_BRIDGE_TOKEN`；令牌不得放进 `VITE_*` 环境变量。

在工作台的模型设置中填写 Jev API Key 和模型名称。密钥使用系统凭据存储，读取接口只返回是否已配置。Jev 专门用于浏览器决策，不加入普通聊天模型列表。输入文字复用已配置的普通模型；没有文字模型时应先配置，再运行需要填写输入框的任务。

创建或选择一个实际会话后，打开右侧面板的浏览器，输入网址与任务目标，再启动 Jev。默认逐步确认每次点击、输入或选择；取消勾选“逐步确认”后自动执行本次任务。关闭面板、切换会话或点击停止会撤销后续操作；已经送达网页的点击不能自动回滚。

## 验收边界

- 先使用本地搜索页面验证真实 Electron、Python、WebSocket 与动作执行，模型部分用确定性替身，避免依赖网络与费用。
- 真实 Jev 验收需要用户在设置中填写可用 API Key；模拟通过不等于真实模型通过。
- Jev 返回 `DONE` 时标记“待核验”，用户需要检查页面实际结果。它不是独立成功证明。
- 支持普通 HTML 表单、按钮、链接、原生选择框、页面滚动与等待。复杂 iframe、Shadow DOM、Canvas、上传、新窗口及复杂键盘控件不在首版验收范围。
- 页面文本和操作候选会发送给 TypeSafe；填写动作的必要上下文会发送给选中的文字模型。
- 内置网页不能访问工作台与后端的服务端口，包含重定向和子资源请求；因此同端口的其他网站也受限。需要验收本地网页时应使用另一个端口。
- 浏览器记录保存在本地 SQLite；后端重启会把未结束任务标为停止，不自动恢复网页操作。
- 浏览器执行记录与聊天工具账本是独立入口，不能把浏览器步骤误报为现有聊天 Agent 已执行的工具调用。

## 后续扩展位置

`domain/browser.py` 定义行为数据与状态；`application/ports/browser.py` 定义浏览器执行和决策端口；基础设施实现 TypeSafe 调用、桌面通道与配置存储；`composition.py` 装配。后续增加视觉模型或另一种浏览器执行器时，应替换端口适配器，不让领域层依赖 Electron、FastAPI 或模型 SDK。

## 本次验证记录（2026-09-21）

- 后端：浏览器专项、数据库迁移及架构检查 57 条通过；mypy 117 个源文件通过。本次变更文件 Ruff 通过，全目录仍有既有 `builtin.py:3` 的 `I001`。
- 后端全量：197 通过、1 失败、1 跳过（636.57 秒）。唯一失败为 `tests/test_session_api.py:443` 的会话用量断言，已在未包含本次改动的 HEAD 隔离副本复现，未修改；跳过项为 Windows 目录符号链接权限不足。不能将本次结果描述为全量测试全绿。
  - 失败用例：`test_session_usage_marks_steps_without_provider_usage_as_partial`。测试期望 `currentContextTokens=None`、`contextEstimated=False`；接口实际返回估算值及 `True`。全量值为 7475，HEAD 隔离值为 7476，其余 8 个字段相同。基线通过 `git archive HEAD backend` 导出，位于 `backend/.pytest_cache/baseline-e59088b16e3e43e3918cfe78adc603b6`，基线提交见下表。
- 前端：全量 16 个测试文件、83 个用例通过；TypeScript 与生产构建通过。构建仍有原有大包及第三方注释警告。
- 桌面：TypeScript、shell 构建及独立浏览器执行器真实 Electron 测试通过。
- 默认生产启动器：使用独立临时状态目录与动态端口，真实启动后端和 Electron，验证经过认证的浏览器通道连接成功；验证后结束本次启动的进程树。
- 最终生产构建的桌面联合验收：设置保存不回显密钥、逐步确认填表搜索并独立读取结果、拒绝未认证控制请求及网页访问后端、等待审批时停止、取消逐步确认后自动执行、收起面板撤销任务，共 6 组通过。
- 联合验收使用确定性模型替身和内存凭据库，实际运行 Electron、HTTP、WebSocket、页面 DOM 和 SQLite；没有验证真实 Jev 推理质量或真实账号可用性，也没有读写用户系统凭据。
- 验收脚本：`desktop/scripts/verify-browser.mjs`。从 desktop 运行 `npm run test:browser`，需要可导入的 Playwright；也可用 `AI_ME_PLAYWRIGHT_MODULE` 指向已安装模块入口。
- 本地证据：`output/playwright/browser-acceptance.json`、`jev-settings.png`、`jev-browser.png`。浏览器截图使用整个原生窗口捕获，包含 WebContentsView；证据目录按现有规则不加入 Git。

## 本地交付与分支审计

工作目录为 `D:/workspac/AI-ME-browser-jev`，分支为 `codex/embedded-browser-jev`。下表记录首次实施结束、尚未提交时的审计快照；后续授权交付的基线修正见本节末尾。原目录 `D:/workspac/AI-ME` 的工作文件未修改。

| 检查项 | 结果 |
| --- | --- |
| 本地 HEAD / main，实施前后均相同 | `80e5a9daddec93a32d6fefa23aa9a3a2c2a11226` |
| 远端基线 origin/main / merge-base | `90c8d7f6bd32270242f069f98015a8d5cf6afd4e` |
| 相对远端基线 ahead / behind | 23 / 0，均为已有本地整合历史 |
| upstream | 无 |
| 后续允许审查的同名推送目标 | `HEAD:refs/heads/codex/embedded-browser-jev`，未执行 |
| 远端功能分支 | 开始及收尾时均不存在 |
| 远端 main | 收尾只读复核仍为上述基线，未写入 |

安全审计发现本地整合历史包含 merge commit 和其他远端功能分支头，不能直接按纯净远端功能分支推送；另外本次改动尚未提交。依照 Git 交付约束暂停提交/推送，不擅自重写或丢弃本地已整合工作台。后续发布前需要确定以哪个基线承接这些已有提交。原目录的 `MISSION.md`、`NOTES.md`、`RESOURCES.md`、`lessons/`、`reference/` 未跟踪文件保持原状。

### 授权交付时的基线修正

用户随后授权处理分支并提交代码。重新 fetch 后确认，远端 `origin/codex/release-zcode-project-skills` 已位于 `80e5a9daddec93a32d6fefa23aa9a3a2c2a11226`，正是本功能依赖的工作台整合基线；不是仅存在于本地、需要重新整合的历史。以该远端分支为基线审计，本功能没有额外 merge commit，也没有混入非基线功能分支。因此按此基线提交浏览器纵向切片，并只交付到同名 `codex/embedded-browser-jev`，不改写历史，不直接推送或合并到 `main`。日后向 main 合并时需要一并审查其尚未纳入的工作台依赖。

### 看不到 Jev 设置时

设置区域标题是“Jev 浏览器模型”，位于普通模型配置表单下方。该入口依赖新版 Electron preload，旧客户端即使读取了新网页也不能获得浏览器能力。应退出旧客户端，从本功能工作目录的 `desktop` 执行 `npm start`；不要继续在原 `AI-ME/desktop` 启动旧版。启动时 8000 端口也应属于新版后端；若旧后端仍占用该端口，先停止明确属于旧客户端的服务，不能盲目复用健康检查通过的旧服务。
