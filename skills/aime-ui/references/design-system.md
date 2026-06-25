# AI-Me UI Design System v0.1

> 用途：供 Codex 在 Multica 源码基础上实现 AI-Me 前端时统一遵循。  
> 目标：像一个安静、可靠、长期运行的「工作驾驶舱」，而不是普通聊天机器人，也不是花哨的多 Agent Demo。

---

## 1. 产品视觉定位

AI-Me 的核心体验是：

- AI 在后台替用户接管和推进工作；
- 用户主要查看结果、风险、证据和待决策事项；
- 界面必须让人感到可靠、可控、清晰，而不是“AI 很炫”；
- 信息密度高，但不能压迫；
- 日常使用以桌面端为主，飞书承担通知和快速审批，CLI 承担工程调试。

视觉关键词：

```text
calm / reliable / precise / minimal / warm / operational
安静 / 可靠 / 精确 / 克制 / 温和 / 工作感
```

禁止把页面做成：

- 营销落地页；
- 大面积渐变和玻璃拟态；
- 聊天机器人气泡堆叠；
- 颜色过多的 Agent 玩具界面；
- 每一块信息都套一层 Card 的“卡片汤”；
- 过度拟人化或游戏化。

---

## 2. 总体设计原则

### 2.1 工作优先，不是聊天优先

主导航和首页首先展示：

1. AI-Me 已完成什么；
2. 正在处理什么；
3. 正在等待谁；
4. 哪些事项需要用户决策；
5. 哪些事项存在风险。

聊天只是一个入口，不应占据首页主体。

### 2.2 例外优先

用户最需要看到的不是所有 Agent 的详细过程，而是：

- 需要批准；
- 低置信度；
- 高风险；
- Agent 意见冲突；
- 缺少上下文；
- 不可逆动作；
- 与用户历史规则冲突。

### 2.3 证据优先

所有 AI 判断页应尽可能呈现：

- 来源；
- 代码路径；
- PR / Commit；
- 原始消息；
- 日志或监控；
- 使用过的记忆和规则；
- Agent 执行记录。

### 2.4 颜色只表达状态

紫色是品牌色，不是装饰色。红、橙、绿、蓝只用于状态和风险，不要大面积涂满页面。

### 2.5 动作必须明确

每个需要用户介入的页面，首要动作必须清楚：

```text
批准 / 发送 / 驳回 / 编辑 / 接管 / 查看证据
```

不要让用户猜下一步。

---

## 3. 设计 Token

### 3.1 CSS Variables

在全局样式中建立统一变量，不允许页面自行写随机颜色、阴影和圆角。

```css
:root {
  /* Brand */
  --aime-brand-50: #f5f2ff;
  --aime-brand-100: #eee9ff;
  --aime-brand-200: #ddd3ff;
  --aime-brand-500: #7657f5;
  --aime-brand-600: #6747e8;
  --aime-brand-700: #5738cf;

  /* Neutral */
  --aime-bg: #f7f8fb;
  --aime-surface: #ffffff;
  --aime-surface-subtle: #fafafd;
  --aime-surface-muted: #f3f4f8;
  --aime-border: #e8e9ef;
  --aime-border-strong: #d9dce5;

  --aime-text: #171923;
  --aime-text-secondary: #626775;
  --aime-text-tertiary: #9398a6;
  --aime-text-disabled: #b7bbc5;

  /* Semantic */
  --aime-success: #218a5b;
  --aime-success-bg: #eaf7f0;
  --aime-warning: #c97a00;
  --aime-warning-bg: #fff5e3;
  --aime-danger: #d94b4b;
  --aime-danger-bg: #fff0f0;
  --aime-info: #3478d4;
  --aime-info-bg: #edf4ff;

  /* Radius */
  --aime-radius-xs: 6px;
  --aime-radius-sm: 8px;
  --aime-radius-md: 12px;
  --aime-radius-lg: 16px;

  /* Shadow */
  --aime-shadow-xs: 0 1px 2px rgba(17, 24, 39, 0.04);
  --aime-shadow-sm: 0 4px 14px rgba(17, 24, 39, 0.06);
  --aime-shadow-md: 0 10px 30px rgba(17, 24, 39, 0.08);

  /* Focus */
  --aime-focus-ring: 0 0 0 3px rgba(118, 87, 245, 0.18);

  /* Layout */
  --aime-sidebar-width: 216px;
  --aime-topbar-height: 64px;
  --aime-detail-width: 392px;
  --aime-page-gutter: 24px;

  /* Motion */
  --aime-duration-fast: 120ms;
  --aime-duration-normal: 180ms;
  --aime-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
}
```

### 3.2 暗色模式

v0.1 不要求暗色模式。不要为了暗色模式拖慢主流程。变量结构需可扩展，但本阶段只保证浅色模式质量。

---

## 4. 字体系统

```css
font-family:
  Inter,
  ui-sans-serif,
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  "PingFang SC",
  "Hiragino Sans GB",
  "Microsoft YaHei",
  sans-serif;
```

建议字号：

| 用途 | 字号 / 行高 | 字重 |
|---|---:|---:|
| 页面主标题 | 24px / 32px | 650 |
| 页面副标题 | 14px / 22px | 400 |
| 区块标题 | 18px / 26px | 600 |
| 卡片标题 | 14px / 20px | 600 |
| 正文 | 14px / 22px | 400 |
| 次级信息 | 13px / 20px | 400 |
| 标签、时间、辅助信息 | 12px / 16px | 500 |
| 数字指标 | 24–30px / 34px | 650 |

规则：

- 不允许正文小于 13px；
- 12px 只用于时间、标签、辅助元数据；
- 不使用全大写英文标题；
- 中文标题不要使用过粗字重；
- 长段落行宽尽量不超过 72 个中文字符。

---

## 5. 间距系统

统一使用 4px 基础网格：

```text
4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48
```

常用规范：

- 页面左右边距：24px；
- 页面顶部内容间距：20–24px；
- 大区块之间：24px；
- 卡片之间：12px；
- 卡片内边距：16px；
- 密集列表行内边距：12px 14px；
- 表单字段间距：16px；
- 图标与文字：8px；
- 标签之间：6px。

禁止出现 13px、17px、19px 等随机值，除非第三方组件兼容所需。

---

## 6. 圆角与阴影

- 输入框、按钮：8px；
- 普通卡片：12px；
- 大面板、Drawer、Modal：16px；
- Badge：999px；
- 不使用超过 18px 的大圆角；
- 不使用浮夸阴影；
- 默认卡片只使用边框或 `shadow-xs`；
- 悬浮卡片最多使用 `shadow-sm`。

卡片基础样式：

```css
.aime-card {
  background: var(--aime-surface);
  border: 1px solid var(--aime-border);
  border-radius: var(--aime-radius-md);
  box-shadow: var(--aime-shadow-xs);
}
```

---

## 7. 应用骨架

### 7.1 主布局

```text
┌──────────────┬─────────────────────────────────────┬───────────────┐
│ 左侧导航     │ 主工作区                            │ 可选详情面板  │
│ 216px        │ 自适应                              │ 392px         │
└──────────────┴─────────────────────────────────────┴───────────────┘
```

- 左侧导航固定；
- 顶栏固定在主工作区顶部；
- 主内容区可独立滚动；
- 右侧详情面板只在选中 Work Item、Approval、Thread 时出现；
- Kanban 允许主区域横向滚动，其他页面尽量禁止整页横向滚动。

### 7.2 左侧导航

导航顺序固定：

```text
工作驾驶舱
工作看板
例外收件箱
审批中心
对话与线程
记忆与知识
AI 员工
工具与权限
设置
```

底部分组：

```text
入口与集成
- 飞书
- GitHub / GitLab
- 邮件
- 告警中心
```

规范：

- 导航栏宽度 216px；
- Logo 区高度 60–64px；
- 单项高度 38–40px；
- Active 背景使用 `brand-50`，文字和图标使用 `brand-600`；
- 未选中项图标和文字使用 `text-secondary`；
- Hover 背景使用 `surface-muted`；
- 数量角标仅用于真正需要注意的未读和待审批事项；
- 集成状态用小绿点和“已连接”，不要使用大块绿色按钮。

### 7.3 顶部栏

左侧：

- 当前页面标题；
- 可选的简短说明或日期；
- 允许存在面包屑，但不要与大标题重复。

右侧：

- AI-Me 在线状态；
- 新建任务按钮；
- 搜索；
- 通知；
- 用户头像。

顶部栏高度 64px，底部使用 1px border，不使用大阴影。

---

## 8. 基础组件规范

### 8.1 按钮

按钮高度：

- 默认：36px；
- 小型：30px；
- 大型：40px。

Primary：

```css
.aime-button-primary {
  background: var(--aime-brand-500);
  color: #fff;
  border: 1px solid var(--aime-brand-500);
  border-radius: var(--aime-radius-sm);
  transition: all var(--aime-duration-normal) var(--aime-ease);
}
.aime-button-primary:hover {
  background: var(--aime-brand-600);
  border-color: var(--aime-brand-600);
}
```

Secondary：白底 + 中性边框。  
Danger：只用于明确危险动作，默认不要填充红色，可先用红色文字和浅红背景。  
Ghost：工具栏或卡片内部次级动作。

规则：

- 一个区域最多一个 Primary；
- “批准并发送”可以是 Primary；
- “查看详情”不应该是 Primary；
- 破坏性操作必须二次确认；
- Loading 时保持按钮宽度不跳动。

### 8.2 输入框

```css
.aime-input {
  height: 36px;
  background: var(--aime-surface);
  border: 1px solid var(--aime-border-strong);
  border-radius: var(--aime-radius-sm);
  color: var(--aime-text);
}
.aime-input:focus {
  border-color: var(--aime-brand-500);
  box-shadow: var(--aime-focus-ring);
  outline: none;
}
```

- Placeholder 使用 `text-tertiary`；
- 错误信息放字段下方；
- 不用红色边框表示所有未填写字段，只用于真正错误。

### 8.3 Badge / Tag

Badge 应短小，不承担长文本：

```text
高风险 / 等待回复 / Codex / 用户问题 / PR Review / 已完成
```

状态必须同时包含文字，不允许只靠颜色。

### 8.4 Tabs

- 高度 36–40px；
- 选中态使用紫色文字和 2px 下划线；
- 不使用大胶囊 Tabs，除非是两个模式切换；
- Tabs 较多时允许横向滚动。

### 8.5 Table

- 表头 12–13px，背景可使用 `surface-subtle`；
- 行高 44–48px；
- Hover 使用浅灰；
- 操作列固定右侧；
- 长文本截断并在详情页展示，避免表格无限扩张。

### 8.6 Drawer / 详情侧栏

- 默认宽度 392px；
- 宽屏可到 420px；
- Header 和底部 Action 区 sticky；
- 内容区独立滚动；
- 顶部显示 ID、风险、标题、来源；
- Tabs：详情 / 对话 / 证据 / AI 分析 / 操作记录。

### 8.7 Modal

- 简单确认：420–480px；
- 编辑内容：640–760px；
- 不要把复杂工作详情塞入 Modal，复杂内容使用右侧 Drawer 或独立页面。

---

## 9. 状态视觉

| 状态 | 颜色 | 背景 |
|---|---|---|
| 新进入 | 中性灰 | `surface-subtle` |
| AI 处理中 | 品牌紫 / 信息蓝 | `brand-50` / `info-bg` |
| 等待外部 | 灰蓝 | `#f3f6fb` |
| 需要我决策 | 橙色 | `warning-bg` |
| 严重风险 | 红色 | `danger-bg` |
| 完成 | 绿色 | `success-bg` |

不要把整个页面涂成状态颜色。颜色应出现在：

- 左侧细线；
- 小型 Badge；
- 图标；
- 柔和的列背景；
- 关键数字。

---

## 10. 左侧菜单各页面 UI 结构

## 10.1 工作驾驶舱

目的：用户每天打开后 10 秒内知道 AI-Me 做了什么、正在做什么、需要自己处理什么。

页面结构：

```text
Header：早上好 + AI-Me 今日接管数量
Summary：已自动完成 / 进行中 / 等待外部 / 需要我决策 / 严重风险
Main：
  左侧 60%：需要我决策
  右侧 40%：进行中的工作
Bottom：今日成果、预计节省时间、异常趋势
```

重点：

- “需要我决策”必须在首屏；
- 每个决策卡片展示：原因、风险、建议、两个主动作；
- 进行中任务展示 Agent、进度、当前阶段和预计完成时间；
- 不展示无意义的 Token 图表作为首页重点。

## 10.2 工作看板

列建议固定为：

```text
新进入
AI 处理中
等待外部
需要我决策
已完成
```

卡片内容层级：

1. 来源和时间；
2. 标题；
3. 一行摘要；
4. 类型 / 风险标签；
5. 当前 Agent 或等待对象；
6. 可选进度条。

列背景只使用非常浅的状态色。卡片统一白底。

## 10.3 例外收件箱

这是 AI-Me 的核心页面之一。

顶部过滤：

```text
全部 / 需要我决策 / 高风险 / 低置信度 / Agent 冲突 / 缺少信息
```

列表卡片必须展示：

- 原始事件；
- AI 判断摘要；
- 风险和置信度；
- 建议动作；
- “查看详情”“编辑回复”“批准并发送”等操作。

不应混入普通完成通知。

## 10.4 审批中心

采用列表 + 详情双栏：

```text
左侧 300px：待审批项列表
右侧：审批内容详情
```

审批类型：

- 对外发送消息；
- 合并 PR；
- 发布文章；
- 部署；
- 数据修改；
- 对外承诺；
- 权限提升。

详情必须显示：

- 要执行的动作；
- 影响范围；
- AI 建议；
- 证据；
- 风险；
- 可回滚性；
- “批准”“编辑后批准”“驳回”。

## 10.5 对话与线程

采用三栏或两栏布局：

```text
左：线程列表 280px
中：对话内容
右：可选任务上下文 / 参与 Agent / 证据
```

消息类型视觉区分：

- 外部用户消息；
- AI-Me 判断；
- Codex / Claude 工作更新；
- 系统事件；
- 审批结果。

不要把所有消息都做成彩色聊天气泡。系统和 Agent 更新应更像时间线条目。

## 10.6 记忆与知识

Tabs：

```text
我的身份
我的偏好
判断规则
项目知识
历史经历
候选记忆
数据来源
```

页面结构：

- 上方搜索；
- 左侧分类；
- 中间记忆列表；
- 右侧详情和来源；
- 候选记忆提供“确认 / 编辑 / 忽略”。

每条记忆展示：

```text
内容
类型
来源
置信度
适用范围
创建时间
最近验证时间
是否可用于对外表达
```

不要只展示向量片段，不要把“知识库”做成文件列表。

## 10.7 AI 员工

分 Tabs：

```text
全部 / Codex Workers / Claude Workers / 其他员工
```

每个 Worker 行展示：

- 名称和 Provider；
- 在线状态；
- 当前任务；
- 今日完成数；
- 平均用时；
- 成功率；
- 最近异常；
- “查看详情 / 暂停 / 配置”。

不要做成游戏角色卡。头像可以有，但信息必须优先。

## 10.8 工具与权限

布局：

```text
左/中：工具清单
右：工具详情和权限规则
```

工具分类：

- 通信工具；
- 开发工具；
- 数据工具；
- 发布工具；
- 系统工具。

每个工具显示：

- 是否启用；
- 当前授权范围；
- 谁可以调用；
- 是否需要审批；
- 最近调用时间；
- 审计日志入口。

权限规则必须是显式文字，例如：

```text
读取代码：自动
发送飞书：需要批准
合并 PR：需要批准
生产部署：始终需要批准
```

## 10.9 设置

Tabs：

```text
个人设置
AI-Me 设置
集成设置
模型设置
安全设置
数据设置
```

设置页面避免“巨型表单”。使用分区卡片，每个分区最多 4–6 个字段。

必须有：

- AI-Me 开关；
- 工作时间；
- 时区；
- 默认自治等级；
- 通知策略；
- LLM Provider / Model；
- 数据目录；
- 记忆容量或保留策略；
- 数据导出 / 清除；
- 版本信息。

---

## 11. 工作项详情页

工作项是系统的核心数据单元。详情页必须包含：

```text
Header
- ID
- 标题
- 状态
- 风险
- 来源
- 创建时间

Tabs
- 概览
- 原始输入
- 执行计划
- Agent 运行
- 证据
- 审批
- 操作记录

Footer / Actions
- 接管
- 暂停
- 取消
- 批准
- 编辑结果
```

概览区建议：

```text
目标
当前判断
当前阶段
下一步
负责人 / Worker
阻塞项
完成标准
```

---

## 12. 动效

- Hover：120–180ms；
- Drawer：180–220ms；
- 列表项新增：轻微 fade + translateY 4px；
- 不使用弹跳、粒子、光效；
- Progress 更新应平滑，但不要模拟虚假进度；
- Reduced Motion 必须可用。

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 13. 响应式规则

优先桌面：1440px、1280px。

### ≥ 1440px

- 左侧导航 216px；
- 主区完整；
- 右侧详情 392px；
- Summary 最多 5 个横排。

### 1100–1439px

- 左侧导航可缩到 196px；
- 右侧详情覆盖式 Drawer；
- Summary 可换成 3 + 2。

### 768–1099px

- 左侧导航折叠为图标栏或抽屉；
- 看板允许横向滚动；
- 详情全屏 Drawer；
- 双栏审批变为上下布局。

### < 768px

v0.1 只保证关键查看和审批能力，不要求完整编辑体验。

---

## 14. 可访问性

- 文本与背景对比度满足 WCAG AA；
- 所有按钮可键盘聚焦；
- Focus ring 不得移除；
- 状态不可只依赖颜色；
- Icon-only 按钮必须有 `aria-label`；
- 表单错误必须通过文字说明；
- Drawer / Modal 打开时必须管理焦点；
- 所有危险操作必须有确认说明。

---

## 15. Loading / Empty / Error

### Loading

- 使用局部 Skeleton；
- 页面顶栏和导航不要反复闪烁；
- 长任务显示真实阶段，不显示虚假百分比。

### Empty

空状态必须告诉用户：

1. 当前为什么为空；
2. 下一步可以做什么。

例如：

```text
暂时没有需要你处理的例外。
AI-Me 会继续在后台推进工作。
```

### Error

错误内容包括：

- 发生了什么；
- 哪个步骤失败；
- 是否已重试；
- 用户可以做什么；
- 查看日志入口。

---

## 16. 图标规范

- 统一使用一套线性图标库；
- 建议 Lucide；
- 默认 16px，导航 18px；
- stroke-width 1.75–2；
- 不混用 Emoji 作为主导航图标；
- Provider Logo 可使用品牌图标，但尺寸和视觉重量统一。

---

## 17. 图表规范

只有当图表帮助用户判断时才使用：

- 工作完成趋势；
- 自主闭环率；
- 用户干预率；
- 错误和回退次数；
- 节省时间趋势。

禁止为了“Dashboard 感”堆无意义图表。

图表：

- 不使用超过 5 种颜色；
- 默认中性灰 + 品牌紫；
- 风险才使用红橙；
- Tooltip 必须提供精确值；
- 不使用 3D 图表。

---

## 18. 实现层硬规则

Codex 在实现 UI 时必须遵守：

1. 优先复用 Multica 已有组件和布局，不创建第二套设计系统；
2. 所有新颜色、间距、圆角、阴影必须来自 Token；
3. 新增组件放入统一 AI-Me UI 目录，不散落复制；
4. 页面不能直接写大段内联 style；
5. 禁止使用 `!important`，除非第三方组件覆盖且有注释；
6. 禁止引入新的大型 UI 框架；
7. 保持 TypeScript 严格类型；
8. 每个页面必须有 Loading、Empty、Error 三态；
9. 所有危险动作必须经过后端权限校验，前端隐藏按钮不等于安全；
10. 每个页面完成后必须在 1440px 和 1280px 两种宽度检查；
11. UI 文案以中文为主，术语保持一致；
12. 不实现与 v0.1 无关的暗色模式、主题商店、复杂动画。

---

## 19. 建议目录结构

```text
packages/
  ui/
    aime/
      tokens.css
      button.tsx
      badge.tsx
      status-dot.tsx
      panel.tsx
      work-item-card.tsx
      risk-badge.tsx
      evidence-list.tsx
      approval-actions.tsx

  views/
    aime/
      cockpit/
      work-board/
      exceptions/
      approvals/
      threads/
      memory/
      agents/
      tools/
      settings/
      work-item-detail/
```

如果 Multica 已有相同职责组件，应扩展现有组件，而不是机械创建重复目录。

---

## 20. Codex 可直接使用的 UI 实现提示词

```text
你正在 Multica 源码中实现 AI-Me UI。

目标不是制作一个花哨的 AI Demo，而是制作一个可靠、克制、高信息密度的工作驾驶舱。AI-Me 会在后台接管用户工作，用户主要查看进度、证据、风险和需要本人决策的例外。

必须遵守以下设计要求：

1. 复用 Multica 当前的 Next.js、组件库、布局和交互模式，不引入第二套大型 UI 框架。
2. 使用 AI-Me 统一 CSS Token；不得在页面中随机写颜色、圆角、阴影和间距。
3. 品牌色为克制的紫色：#7657F5；页面背景 #F7F8FB；Surface 为白色；Border 为 #E8E9EF。
4. 主布局为：216px 左导航 + 自适应主区 + 可选 392px 右详情栏。
5. 主页面不是聊天框。首页首先展示：已完成、进行中、等待外部、需要我决策、严重风险。
6. 最核心入口是“例外收件箱”和“审批中心”。重要动作必须清晰：批准、发送、编辑、驳回、接管。
7. 状态使用小面积柔和色，禁止大面积高饱和色。
8. Card 圆角 12px，输入与按钮 8px，大面板 16px；默认阴影非常轻。
9. 页面正文 14px，辅助信息 12–13px；不得使用过小文字。
10. 禁止玻璃拟态、霓虹渐变、浮夸动画、游戏角色卡和卡片套卡片。
11. 所有页面必须有 loading / empty / error 状态。
12. 状态不能只依赖颜色，必须有文字标签。
13. 所有危险动作必须有确认和风险说明，前端隐藏按钮不能代替后端权限校验。
14. 优先实现桌面 1440px 和 1280px；窄屏下右侧详情改为 Drawer。
15. UI 文案以中文为主，并保持术语一致：工作项、例外、审批、AI 员工、记忆、证据、接管。

页面导航固定为：
- 工作驾驶舱
- 工作看板
- 例外收件箱
- 审批中心
- 对话与线程
- 记忆与知识
- AI 员工
- 工具与权限
- 设置

在开始编码前：
- 阅读现有 Multica 的 layout、sidebar、board、issue detail、drawer、button、badge、tabs、table 组件；
- 列出可复用组件；
- 提交一个最小改造计划；
- 避免重写已有设计系统。

每完成一个页面：
- 运行 typecheck 和相关测试；
- 检查 1440px、1280px 布局；
- 检查 keyboard focus；
- 检查 empty/loading/error；
- 截图供人工验收。
```

---

## 21. 高清 UI 出图规则

后续生成 UI 参考图时，不再把 8–9 个页面压缩到一张大图中。那会导致每个页面只能占很小的像素区域，文字和细节自然模糊。

正确做法：

- 每个页面单独生成；
- 统一 16:10 或 3:2 桌面比例；
- 单页至少 1536×1024；
- 重点页面可使用 1792×1024；
- 相同侧栏、顶栏和 Token；
- 每次只展示 1 个主页面，最多附带 1 个右侧详情 Drawer；
- 不用拼贴式九宫格作为开发参考。

建议优先分别输出：

1. 工作驾驶舱；
2. 例外收件箱；
3. 审批中心；
4. 记忆与知识；
5. AI 员工；
6. 工具与权限。
