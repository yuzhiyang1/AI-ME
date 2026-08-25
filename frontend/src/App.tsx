import {
  Activity,
  Bell,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Command,
  Gauge,
  Inbox,
  ListTodo,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Wrench,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface NavigationItem {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  count?: number;
}

interface NavigationSection {
  label?: string;
  items: NavigationItem[];
}

const navigation: NavigationSection[] = [
  {
    items: [
      { label: "工作驾驶舱", icon: Gauge, active: true },
      { label: "工作事项", icon: ListTodo },
      { label: "例外收件箱", icon: Inbox, count: 3 },
      { label: "审批中心", icon: ShieldCheck, count: 2 },
    ],
  },
  {
    label: "Agent 能力",
    items: [
      { label: "运行与证据", icon: Activity },
      { label: "SOP", icon: Workflow },
      { label: "记忆与知识", icon: BrainCircuit },
      { label: "工具与权限", icon: Wrench },
    ],
  },
];

const metrics = [
  { label: "今日已托管", value: "0", note: "等待第一项工作", icon: CheckCircle2, tone: "success" },
  { label: "正在处理", value: "0", note: "Agent 当前空闲", icon: Activity, tone: "brand" },
  { label: "等待外部", value: "0", note: "没有阻塞事项", icon: Clock3, tone: "neutral" },
  { label: "需要决策", value: "0", note: "没有待审批动作", icon: CircleAlert, tone: "warning" },
  { label: "本周节省", value: "0h", note: "从真实结果开始统计", icon: Sparkles, tone: "violet" },
] as const;

const setupSteps = [
  { title: "接入一个信息源", description: "GitHub、飞书或日志平台", action: "配置" },
  { title: "写下第一条 SOP", description: "从重复最多的工作开始", action: "创建" },
  { title: "完成可验证运行", description: "保留过程、证据和反馈", action: "了解" },
];

function BrandMark() {
  return <span className="brand-mark">ME</span>;
}

function WindowBar() {
  return (
    <div className="window-bar" aria-label="AI-ME 桌面标题栏">
      <div className="window-brand">
        <BrandMark />
        <strong>AI-ME</strong>
        <span className="window-beta">alpha</span>
      </div>
      <div className="window-context">
        <span>Personal operations</span>
        <span className="window-context-dot" />
        <span>Local workspace</span>
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="sidebar">
      <button className="workspace-switcher" type="button" aria-label="切换工作空间">
        <span className="workspace-avatar">张</span>
        <span className="workspace-copy">
          <strong>个人工作台</strong>
          <small>Local workspace</small>
        </span>
        <ChevronDown size={14} />
      </button>

      <nav className="navigation" aria-label="主导航">
        {navigation.map((section, sectionIndex) => (
          <section className="nav-section" key={section.label ?? sectionIndex}>
            {section.label ? <p className="nav-label">{section.label}</p> : null}
            <div className="nav-list">
              {section.items.map(({ label, icon: NavIcon, active, count }) => (
                <button className={`nav-item${active ? " is-active" : ""}`} type="button" key={label}>
                  <NavIcon size={17} strokeWidth={1.8} />
                  <span>{label}</span>
                  {count ? <span className="nav-count">{count}</span> : null}
                </button>
              ))}
            </div>
          </section>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <div className="local-agent-status">
          <span className="status-orb"><Bot size={14} /></span>
          <span>
            <strong>AI-ME 已就绪</strong>
            <small>等待第一项工作</small>
          </span>
          <span className="online-dot" />
        </div>
        <button className="nav-item settings-item" type="button">
          <Settings size={17} strokeWidth={1.8} />
          <span>设置</span>
          <ChevronRight size={14} />
        </button>
      </div>
    </aside>
  );
}

function MetricStrip() {
  return (
    <section className="metrics" aria-label="工作概览">
      {metrics.map(({ label, value, note, icon: MetricIcon, tone }) => (
        <article className={`metric-card tone-${tone}`} key={label}>
          <div className="metric-label">
            <MetricIcon size={14} strokeWidth={2} />
            <span>{label}</span>
          </div>
          <div className="metric-value-row">
            <strong>{value}</strong>
            <span>{note}</span>
          </div>
        </article>
      ))}
    </section>
  );
}

function CurrentWorkPanel() {
  return (
    <section className="surface current-work-panel">
      <header className="surface-header">
        <div>
          <div className="section-title-row">
            <h2>当前运行</h2>
            <span className="quiet-badge">0 active</span>
          </div>
          <p>执行过程、工具调用和证据会在这里连续呈现</p>
        </div>
        <button className="text-button" type="button">查看全部 <ChevronRight size={14} /></button>
      </header>

      <div className="run-empty-state">
        <div className="empty-visual" aria-hidden="true">
          <span className="orbit orbit-one" />
          <span className="orbit orbit-two" />
          <span className="agent-core"><Bot size={23} strokeWidth={1.8} /></span>
        </div>
        <div className="empty-copy">
          <span className="empty-kicker">Ready when you are</span>
          <h3>把第一件噪音工作交给 AI-ME</h3>
          <p>它会按照 SOP 执行，遇到边界时暂停，并把过程证据交给你确认。</p>
        </div>
        <button className="primary-button" type="button"><Plus size={16} /> 新建工作事项</button>
        <div className="capability-row" aria-label="可配置能力">
          <span>信息源</span><i />
          <span>SOP</span><i />
          <span>工具</span><i />
          <span>审批</span>
        </div>
      </div>
    </section>
  );
}

function SetupPanel() {
  return (
    <section className="surface setup-panel">
      <header className="surface-header compact-header">
        <div>
          <div className="section-title-row">
            <h2>启动进度</h2>
            <span className="progress-count">0 / 3</span>
          </div>
          <p>从一个真实场景开始搭建</p>
        </div>
      </header>
      <div className="progress-track"><span /></div>
      <div className="setup-steps">
        {setupSteps.map((step, index) => (
          <button className="setup-step" type="button" key={step.title}>
            <span className="step-number">{index + 1}</span>
            <span className="step-copy">
              <strong>{step.title}</strong>
              <small>{step.description}</small>
            </span>
            <span className="step-action">{step.action}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function RuntimePanel({ isDesktop }: { isDesktop: boolean }) {
  return (
    <section className="runtime-panel">
      <div className="runtime-title">
        <span className="runtime-icon"><Command size={15} /></span>
        <div>
          <strong>本地 Agent Runtime</strong>
          <small>{isDesktop ? "客户端安全边界已启用" : "当前为 Web 预览模式"}</small>
        </div>
      </div>
      <dl className="runtime-facts">
        <div><dt>模型</dt><dd>未配置</dd></div>
        <div><dt>工具</dt><dd>0 connected</dd></div>
      </dl>
    </section>
  );
}

function App() {
  const isDesktop = window.aiMeDesktop?.mode === "desktop";

  return (
    <div className={`app-shell ${isDesktop ? "is-desktop" : "is-web"}`}>
      {isDesktop ? <WindowBar /> : null}
      <Sidebar />

      <div className="workspace">
        <header className="topbar">
          <div className="page-heading">
            <div className="page-title-line">
              <h1>我的工作驾驶舱</h1>
              <span className="greeting">早上好，今天先守住主线。</span>
            </div>
            <p>AI-ME 会接住重复工作，只在需要你判断时打扰你。</p>
          </div>
          <div className="topbar-actions">
            <button className="icon-button" type="button" aria-label="搜索"><Search size={18} /></button>
            <button className="status-button" type="button">
              <span className="online-dot" />
              {isDesktop ? "本地运行" : "Web 预览"}
              <ChevronDown size={13} />
            </button>
            <button className="primary-button topbar-primary" type="button"><Plus size={16} /> 新建工作</button>
            <button className="icon-button notification-button" type="button" aria-label="通知">
              <Bell size={18} />
              <span />
            </button>
            <span className="user-avatar">张</span>
          </div>
        </header>

        <main className="content" id="main-content">
          <MetricStrip />

          <div className="view-bar">
            <div className="view-tabs" role="tablist" aria-label="驾驶舱视图">
              <button className="view-tab is-active" type="button" role="tab" aria-selected="true">概览</button>
              <button className="view-tab" type="button" role="tab" aria-selected="false">今日清单</button>
              <button className="view-tab" type="button" role="tab" aria-selected="false">运行记录</button>
            </div>
            <span className="sync-state"><span className="sync-dot" /> 本地状态已同步</span>
          </div>

          <div className="dashboard-grid">
            <CurrentWorkPanel />
            <aside className="right-rail">
              <SetupPanel />
              <RuntimePanel isDesktop={isDesktop} />
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
