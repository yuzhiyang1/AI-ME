/**
 * AI-ME 对 ZCode 工作台的前端适配层。
 *
 * 页面只依赖这个门面，不直接依赖后端 URL。这样后续接入终端、文件树、
 * Git 或远程工作区时，可以继续沿用 ZCode 页面组件而不重写页面编排。
 */
import {
  createProject,
  createSession,
  decideApproval,
  deleteProject,
  getActiveTurn,
  getSession,
  getSessionUsage,
  interruptTurn,
  listModels,
  listPendingApprovals,
  listProjects,
  listSessionItems,
  listSessions,
  listToolInvocations,
  startTurn,
  streamRuntimeEvents,
  updateProject,
} from "../api";

export const aiMeWorkspaceAdapter = {
  listModels,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  listSessions,
  createSession,
  getSession,
  listSessionItems,
  getActiveTurn,
  getSessionUsage,
  startTurn,
  interruptTurn,
  listPendingApprovals,
  decideApproval,
  listToolInvocations,
  streamRuntimeEvents,
} as const;

export type AiMeWorkspaceAdapter = typeof aiMeWorkspaceAdapter;
