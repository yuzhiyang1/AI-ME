/** AI-ME 本地 HTTP API 的稳定客户端契约。 */

export interface SkillEntry {
  ref: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  pinned: boolean;
  explicit_only: boolean;
  shadowed: boolean;
  source?: string;
}

export function listSkills(sessionId?: string): Promise<{skills: SkillEntry[]; diagnostics: string[]}> {
  return request(sessionId ? `/api/sessions/${sessionId}/skills` : "/api/skills");
}

export function saveSkillPreference(sessionId: string | undefined, skill: SkillEntry): Promise<{saved: boolean}> {
  return request(sessionId ? `/api/sessions/${sessionId}/skills/preference` : "/api/skills/preference", {
    method: "PUT",
    body: JSON.stringify({ref: skill.ref, enabled: skill.enabled, pinned: skill.pinned}),
  });
}

export type PermissionProfile = "read_only" | "workspace_write" | "full_access";
export type SessionActivity = "idle" | "queued" | "running" | "waiting_for_user";
export type SessionItemType = "user_message" | "agent_message" | "error";

export interface ModelDescriptor {
  ref: string;
  provider: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
}

export type ModelProtocol = "openai_completions" | "anthropic_messages";

export interface ModelConfiguration {
  id: string;
  modelRef: string;
  provider: string;
  modelId: string;
  displayName: string;
  protocol: ModelProtocol;
  baseUrl: string | null;
  contextWindow: number;
  credentialStored: boolean;
  createdAt: string;
}

export interface CreateModelConfigurationInput {
  provider: string;
  modelId: string;
  displayName: string;
  protocol: ModelProtocol;
  baseUrl: string | null;
  apiKey: string;
  contextWindow: number;
}

export interface AgentSession {
  id: string;
  title: string;
  projectId: string | null;
  workspacePath: string;
  workspaceRoots: string[];
  defaultModel: string;
  permissionProfile: PermissionProfile;
  lifecycle: "active" | "archived";
  activity: SessionActivity;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  contextUsage?: SessionContextUsage;
}

export interface SessionContextUsage {
  currentContextTokens: number | null;
  contextWindow: number | null;
  percentage: number | null;
  partial: boolean;
}

export interface ProjectRoot {
  path: string;
  position: number;
  primary: boolean;
}

export interface Project {
  id: string;
  name: string;
  roots: ProjectRoot[];
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveProjectInput {
  name: string;
  roots: string[];
}

export interface SessionItem {
  id: string;
  sessionId: string;
  turnId: string;
  runId: string | null;
  sequence: number;
  type: SessionItemType;
  status: "in_progress" | "completed" | "failed";
  content: Record<string, unknown>;
  createdAt: string;
}

export interface RuntimeEvent {
  id: string;
  sessionId: string;
  turnId: string;
  runId: string | null;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SessionTokenUsage {
  windowNumber?: number | null;
  contextEstimated?: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  currentContextTokens: number | null;
  contextWindow: number | null;
  measuredSteps: number;
  unreportedSteps: number;
  untrackedHistory: boolean;
}

interface CreateSessionBaseInput {
  defaultModel: string;
  permissionProfile: PermissionProfile;
}

export type CreateSessionInput = CreateSessionBaseInput &
  (
    | { projectId: string; workspacePath?: never }
    | { projectId?: null; workspacePath: string }
  );

export interface AgentTurn {
  id: string;
  sessionId: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type ApprovalDecision = "approve_once" | "approve_session" | "reject";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  turnId: string;
  runId: string;
  invocationId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  status: "pending" | "approved" | "rejected";
  decision: ApprovalDecision | null;
  requestedAt: string;
  resolvedAt: string | null;
}

export interface ToolInvocation {
  id: string;
  sessionId: string;
  turnId: string;
  runId: string;
  callId: string;
  stepIndex: number;
  callIndex: number;
  toolName: string;
  arguments: Record<string, unknown>;
  assistantText: string;
  executionSemantics: "parallel" | "exclusive_step";
  riskLevel: "read" | "workspace_write" | "shell";
  status:
    | "prepared"
    | "waiting_for_approval"
    | "running"
    | "completed"
    | "failed"
    | "rejected"
    | "uncertain";
  result: Record<string, unknown> | null;
  isError: boolean | null;
  preparedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface ApiModelDescriptor {
  ref: string;
  provider: string;
  model_id: string;
  display_name: string;
  context_window: number;
}

const apiBaseUrl =
  (typeof window !== "undefined" ? window.aiMeDesktop?.apiBaseUrl : undefined) ??
  (import.meta.env.DEV
    ? "http://127.0.0.1:8000"
    : typeof window !== "undefined"
      ? window.location.origin
      : "");

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new ApiError(body?.detail ?? `请求失败（${response.status}）`, response.status);
  }
  return (await response.json()) as T;
}

export async function listModels(): Promise<ModelDescriptor[]> {
  const models = await request<ApiModelDescriptor[]>("/api/models");
  return models.map((model) => ({
    ref: model.ref,
    provider: model.provider,
    modelId: model.model_id,
    displayName: model.display_name,
    contextWindow: model.context_window,
  }));
}

export function listModelConfigurations(): Promise<ModelConfiguration[]> {
  return request<ModelConfiguration[]>("/api/settings/models");
}

export function createModelConfiguration(
  input: CreateModelConfigurationInput,
): Promise<ModelConfiguration> {
  return request<ModelConfiguration>("/api/settings/models", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listSessions(): Promise<AgentSession[]> {
  return request<AgentSession[]>("/api/sessions");
}

export function listProjects(): Promise<Project[]> {
  return request<Project[]>("/api/projects");
}

export function createProject(
  input: SaveProjectInput,
  idempotencyKey: string,
): Promise<Project> {
  return request<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      roots: input.roots.map((path) => ({ path })),
      idempotencyKey,
    }),
  });
}

export function updateProject(projectId: string, input: SaveProjectInput): Promise<Project> {
  return request<Project>(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: input.name,
      roots: input.roots.map((path) => ({ path })),
    }),
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/projects/${projectId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new ApiError(body?.detail ?? `删除项目失败（${response.status}）`, response.status);
  }
}

export function getSession(sessionId: string): Promise<AgentSession> {
  return request<AgentSession>(`/api/sessions/${sessionId}`);
}

export function getSessionUsage(sessionId: string): Promise<SessionTokenUsage> {
  return request<SessionTokenUsage>(`/api/sessions/${sessionId}/usage`);
}

export function getActiveTurn(sessionId: string): Promise<AgentTurn | null> {
  return request<AgentTurn | null>(`/api/sessions/${sessionId}/turns/active`);
}

export function getTurnByClientRequest(
  sessionId: string,
  clientRequestId: string,
  signal?: AbortSignal,
): Promise<AgentTurn | null> {
  const query = new URLSearchParams({ clientRequestId });
  return request<AgentTurn | null>(
    `/api/sessions/${sessionId}/turns/by-client-request?${query}`,
    { signal },
  );
}

export function createSession(input: CreateSessionInput): Promise<AgentSession> {
  return request<AgentSession>("/api/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listSessionItems(sessionId: string): Promise<SessionItem[]> {
  return request<SessionItem[]>(`/api/sessions/${sessionId}/items`);
}

export function startTurn(
  sessionId: string,
  input: string,
  clientRequestId: string,
  signal?: AbortSignal,
): Promise<AgentTurn> {
  return request<AgentTurn>(`/api/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({ input, clientRequestId }),
    signal,
  });
}

export async function interruptTurn(sessionId: string, turnId: string): Promise<void> {
  const response = await fetch(
    `${apiBaseUrl}/api/sessions/${sessionId}/turns/${turnId}/interrupt`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new ApiError(body?.detail ?? `中断失败（${response.status}）`, response.status);
  }
}

export function listPendingApprovals(sessionId: string): Promise<ApprovalRequest[]> {
  return request<ApprovalRequest[]>(`/api/sessions/${sessionId}/approvals`);
}

export function listToolInvocations(sessionId: string): Promise<ToolInvocation[]> {
  return request<ToolInvocation[]>(`/api/sessions/${sessionId}/tool-invocations`);
}

export function decideApproval(
  sessionId: string,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<ApprovalRequest> {
  return request<ApprovalRequest>(
    `/api/sessions/${sessionId}/approvals/${approvalId}/decision`,
    {
      method: "POST",
      body: JSON.stringify({ decision }),
    },
  );
}

export async function streamRuntimeEvents(
  sessionId: string,
  afterSequence: number,
  onEvent: (event: RuntimeEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const query = new URLSearchParams({ afterSequence: String(afterSequence) });
  const response = await fetch(`${apiBaseUrl}/api/sessions/${sessionId}/events?${query}`, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || !response.body) {
    throw new ApiError(`事件流连接失败（${response.status}）`, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (data) {
        onEvent(JSON.parse(data) as RuntimeEvent);
      }
    }
    if (done) {
      return;
    }
  }
}
