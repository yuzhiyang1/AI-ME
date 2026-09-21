# ZCode 原版前端源码

来源：https://github.com/zai-org/ZCode

固定版本：872ad960de7ec172591f7e1952f7849229f94521（2026-09-21，feat: open source）。

`packages/ui`、`packages/web` 保留上游完整 src；shared、provider、model-option-map、rpc、services、client 为渲染层依赖和服务契约。services 的 Node 实现仅随源码保留，不作为 AI-ME 后端启动。

许可证全文、项目声明、第三方声明分别保存在本目录的 LICENSE、NOTICE.md、THIRD-PARTY-NOTICES.md。它们描述上游产品；AI-ME 具体接入范围由宿主适配器决定。

AI-ME 入口和服务适配代码位于 frontend/src/workbench。未经修改的上游文件保留原文；任何上游修改必须加修改说明并在此记录。

迁移验收以实际渲染原版 Root/App/WorkspaceShellLayout 为准，不能以文件存在或能力名称列表作为完成证明。

## AI-ME 修改记录（2026-09-21）

- `ui/src/Root.tsx`、`ui/src/root/types.ts`：增加宿主管理模型连接的开关，不要求 AI-ME 用户登录 ZCode 商业账号。
- `ui/src/hooks/useZCode{Agent,Session,Task}Service.ts`：修复工作区从空值加载为路径时改变 Hook 调用顺序的问题。
- `shared/src/platform.ts`、`ui/src/v4/SessionPane.tsx`：声明并尊重草稿预热能力，AI-ME 在首次发送时才创建真实会话，避免空任务污染。
- `ui/src/styles.css`：调整 Streamdown 样式扫描路径，适配源码内置目录。
- 补充上游 `zcode-cua` 的公开占位包与 `public/icon_512@2x.png`，仅满足原版渲染依赖；不表示电脑操作能力已经实现。
- AI-ME 的依赖装配使用 `linkify-it@6.1.0` 覆盖 ANSI 查看器的旧间接依赖，修复上游依赖链的高危复杂度漏洞；原始 package.json 保留作来源记录，不作为安装入口。
- `ui/src/WorkspaceSidebarFooter.tsx`：删除账号头像、登录/退出、套餐摘要和升级入口，保留本地偏好菜单。
- `ui/src/Root.tsx`：不再传递登录/退出操作，忽略旧 JWT 失效导航标记；`ui/src/settings/AutomationsSection.tsx` 的未接入能力不再引导购买。
- `ui/src/styles.css`：增加 AI-ME 本地宿主组件的 Tailwind 扫描路径。
- `frontend/vite.config.ts` 在构建边界用 `src/workbench/local-account.jsx` 替换 OAuth 恢复、欢迎登录页、购买面板和商业额度提示，用 `LocalModelSettings.jsx` 替换模型提供方页面。上游原文件保留作来源记录，不进入 AI-ME 的账号/购买运行链路；构建检查禁止重新引入登录与购买实现，Stripe 依赖已从 AI-ME 安装清单移除。未更改上游许可证或版权声明。

入口迁移和核心对话接通不等于全部宿主接口已完成。当前验收及缺口见 `frontend/ZCODE-INTEGRATION.md`。

## 项目和 Skill 兼容补丁（2026-09-21）

- `shared/src/platform.ts`、`ui/src/root/useRootWorkspaceActions.ts`、`WorkspaceSidebarFooter.tsx`：添加可选宿主项目选择/管理入口。
- `ui/src/Root.tsx`、`root/types.ts`：提供当前窗口 Provider 内的宿主扩展挂载点，项目更新不重建工作台。
- `ui/src/lib/hostWorkspaceLabel.ts`、`lib/path.ts`、`store/tabStore.ts`：宿主逻辑工作区用项目名称展示，上游普通目录保持原逻辑。
- `ui/src/lib/skillSourceFilter.ts`、`settings/SkillsSection.tsx`、`shared/src/skills-types.ts`、`services/src/skills/skills.ts`：接受 AI-ME 授权技能来源、保留固定偏好、声明未实现的文件操作，不改上游 Skill 布局与交互体系。
- `shared/src/zcode-protocol-v4/snapshot.ts`、`ui/src/v4/composer/V4ComposerToolbar.tsx`：增量展示 AI-ME 预算估算标记和窗口序号。
- 上游 LICENSE、NOTICE 和第三方版权声明未改动。以上均为 AI-ME 本地接入修改，不宣称属于上游实现。
