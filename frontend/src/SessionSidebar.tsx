import {
  ChevronDown,
  ChevronRight,
  Folder,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AgentSession, Project } from "./api";
import { SessionContextRing } from "./SessionContextRing";

type SessionSidebarProps = {
  projects: Project[];
  sessions: AgentSession[];
  activeSessionId: string | null;
  loading: boolean;
  onOpenSession: (session: AgentSession) => void;
  onCreateProject: () => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onCreateSession: (project: Project) => void;
};

/** 按持久 Project 和不绑定项目的任务组织 Session，不在前端猜测路径归属。 */
export function SessionSidebar(props: SessionSidebarProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const sessionsByProject = useMemo(() => {
    const grouped = new Map<string, AgentSession[]>();
    for (const session of props.sessions) {
      if (session.projectId === null) continue;
      const current = grouped.get(session.projectId) ?? [];
      current.push(session);
      grouped.set(session.projectId, current);
    }
    return grouped;
  }, [props.sessions]);
  const tasks = props.sessions.filter((session) => session.projectId === null);

  useEffect(() => {
    // 删除项目后同步清理无效的本地折叠记录。
    const ids = new Set(props.projects.map((project) => project.id));
    setCollapsed((current) => new Set([...current].filter((id) => ids.has(id))));
  }, [props.projects]);

  function toggleProject(projectId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  return (
    <nav className="session-navigation" aria-label="Agent 会话">
      <div className="sidebar-section-heading">
        <span>项目</span>
        <button type="button" aria-label="新增项目" onClick={props.onCreateProject}>
          <Plus size={14} />
        </button>
      </div>
      {props.loading ? <p className="sidebar-hint">正在恢复本地会话…</p> : null}
      {!props.loading && props.projects.length === 0 ? (
        <p className="sidebar-hint">还没有项目</p>
      ) : null}
      {props.projects.map((project) => {
        const isCollapsed = collapsed.has(project.id);
        const projectSessions = sessionsByProject.get(project.id) ?? [];
        return (
          <section
            className="project-group"
            role="group"
            aria-label={`项目 ${project.name}`}
            key={project.id}
          >
            <div className="project-row">
              <button
                className="project-toggle"
                type="button"
                aria-label={`${isCollapsed ? "展开" : "收起"}项目 ${project.name}`}
                aria-expanded={!isCollapsed}
                onClick={() => toggleProject(project.id)}
              >
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <Folder size={14} />
                <span>{project.name}</span>
              </button>
              <div className="project-actions">
                <button
                  type="button"
                  aria-label={`在 ${project.name} 中新建会话`}
                  onClick={() => props.onCreateSession(project)}
                >
                  <Plus size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`编辑项目 ${project.name}`}
                  onClick={() => props.onEditProject(project)}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  aria-label={`删除项目 ${project.name}`}
                  onClick={() => props.onDeleteProject(project)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            {!isCollapsed ? (
              <div className="project-session-list">
                {projectSessions.length === 0 ? (
                  <p className="project-empty">暂无会话</p>
                ) : (
                  projectSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={props.activeSessionId === session.id}
                      onOpen={props.onOpenSession}
                    />
                  ))
                )}
              </div>
            ) : null}
          </section>
        );
      })}

      <section className="task-group" role="group" aria-label="任务">
        <div className="sidebar-section-heading task-heading"><span>任务</span></div>
        {!props.loading && tasks.length === 0 ? (
          <p className="sidebar-hint">还没有独立任务</p>
        ) : null}
        {tasks.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            active={props.activeSessionId === session.id}
            onOpen={props.onOpenSession}
          />
        ))}
      </section>
    </nav>
  );
}

function SessionRow({
  session,
  active,
  onOpen,
}: {
  session: AgentSession;
  active: boolean;
  onOpen: (session: AgentSession) => void;
}) {
  return (
    <button
      className={`session-row${active ? " is-active" : ""}`}
      type="button"
      onClick={() => onOpen(session)}
    >
      <span className="session-icon">
        <MessageSquare size={13} />
        {session.activity !== "idle" ? <span className="running-dot" /> : null}
      </span>
      <span className="session-copy"><strong>{session.title}</strong></span>
      <SessionContextRing
        usage={session.contextUsage}
        label={`${session.title}上下文占用`}
        size={15}
      />
    </button>
  );
}
