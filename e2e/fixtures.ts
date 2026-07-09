/**
 * TestApiClient — lightweight API helper for E2E test data setup/teardown.
 *
 * Uses raw fetch so E2E tests have zero build-time coupling to the web app.
 */

import "./env";
import pg from "pg";

// `||` (not `??`) so an empty `NEXT_PUBLIC_API_URL=` in .env still falls
// back to localhost. dotenv sets unset-vs-empty both as "" — treating them
// the same matches user intent.
const API_BASE = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || "8080"}`;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://multica:multica@localhost:5432/multica?sslmode=disable";

interface TestWorkspace {
  id: string;
  name: string;
  slug: string;
}

interface TestRuntime {
  id: string;
  workspace_id: string;
  daemon_id: string | null;
  name: string;
  provider: string;
  status: string;
}

interface TestAgent {
  id: string;
  workspace_id: string;
  runtime_id: string;
  name: string;
}

interface TestAIApproval {
  id: string;
  status: string;
  execution_status: string;
  created_task_id: string | null;
}

interface TestAgentTask {
  id: string;
  agent_id: string;
  runtime_id: string;
  issue_id: string;
  status: "queued" | "dispatched" | "running" | "completed" | "failed" | "cancelled";
}

export class TestApiClient {
  private token: string | null = null;
  private workspaceSlug: string | null = null;
  private workspaceId: string | null = null;
  private createdIssueIds: string[] = [];
  private createdApprovalIds: string[] = [];
  private createdTaskIds: string[] = [];
  private createdAgentIds: string[] = [];
  private createdRuntimeIds: string[] = [];

  async login(email: string, name: string) {
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      // Keep each E2E login isolated so previous test runs do not trip the
      // per-email send-code rate limit.
      await client.query("DELETE FROM verification_code WHERE email = $1", [email]);

      // Step 1: Send verification code
      const sendRes = await fetch(`${API_BASE}/auth/send-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!sendRes.ok) {
        throw new Error(`send-code failed: ${sendRes.status}`);
      }

      // Step 2: Read code from database
      const result = await client.query(
        "SELECT code FROM verification_code WHERE email = $1 AND used = FALSE AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
        [email],
      );
      if (result.rows.length === 0) {
        throw new Error(`No verification code found for ${email}`);
      }

      // Step 3: Verify code to get JWT
      const verifyRes = await fetch(`${API_BASE}/auth/verify-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: result.rows[0].code }),
      });
      if (!verifyRes.ok) {
        throw new Error(`verify-code failed: ${verifyRes.status}`);
      }
      const data = await verifyRes.json();

      this.token = data.token;

      // Update user name if needed
      if (name && data.user?.name !== name) {
        await this.authedFetch("/api/me", {
          method: "PATCH",
          body: JSON.stringify({ name }),
        });
      }

      await client.query("DELETE FROM verification_code WHERE email = $1", [email]);

      return data;
    } finally {
      await client.end();
    }
  }

  async getWorkspaces(): Promise<TestWorkspace[]> {
    const res = await this.authedFetch("/api/workspaces");
    return res.json();
  }

  setWorkspaceId(id: string) {
    this.workspaceId = id;
  }

  setWorkspaceSlug(slug: string) {
    this.workspaceSlug = slug;
  }

  async ensureWorkspace(name = "E2E Workspace", slug = "e2e-workspace") {
    const workspaces = await this.getWorkspaces();
    const workspace = workspaces.find((item) => item.slug === slug) ?? workspaces[0];
    if (workspace) {
      this.workspaceId = workspace.id;
      this.workspaceSlug = workspace.slug;
      return workspace;
    }

    const res = await this.authedFetch("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, slug }),
    });
    if (res.ok) {
      const created = (await res.json()) as TestWorkspace;
      this.workspaceId = created.id;
      this.workspaceSlug = created.slug;
      return created;
    }

    const refreshed = await this.getWorkspaces();
    const created = refreshed.find((item) => item.slug === slug) ?? refreshed[0];
    if (created) {
      this.workspaceId = created.id;
      return created;
    }

    throw new Error(`Failed to ensure workspace ${slug}: ${res.status} ${res.statusText}`);
  }

  getWorkspaceId() {
    if (!this.workspaceId) {
      throw new Error("workspace is not initialized");
    }
    return this.workspaceId;
  }

  getWorkspaceSlug() {
    if (!this.workspaceSlug) {
      throw new Error("workspace is not initialized");
    }
    return this.workspaceSlug;
  }

  async createIssue(title: string, opts?: Record<string, unknown>) {
    const res = await this.authedFetch("/api/issues", {
      method: "POST",
      body: JSON.stringify({ title, ...opts }),
    });
    const issue = await res.json();
    this.createdIssueIds.push(issue.id);
    return issue;
  }

  async deleteIssue(id: string) {
    await this.authedFetch(`/api/issues/${id}`, { method: "DELETE" });
  }

  async dismissStarterContent() {
    await this.authedFetch("/api/me/starter-content/dismiss", {
      method: "POST",
      body: JSON.stringify({ workspace_id: this.workspaceId }),
    });
  }

  async registerRuntime(opts?: {
    daemonId?: string;
    name?: string;
    provider?: string;
  }): Promise<TestRuntime> {
    const stamp = Date.now();
    const daemonId = opts?.daemonId ?? `aime-e2e-${stamp}`;
    const provider = opts?.provider ?? "codex";
    const res = await this.authedFetch("/api/daemon/register", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: this.getWorkspaceId(),
        daemon_id: daemonId,
        device_name: "AI-Me E2E Device",
        cli_version: "e2e",
        launched_by: "e2e",
        runtimes: [
          {
            name: opts?.name ?? `AI-Me E2E Runtime ${stamp}`,
            type: provider,
            version: "e2e",
            status: "online",
          },
        ],
      }),
    });
    const body = await this.parseJSON<{ runtimes: TestRuntime[] }>(res, "register runtime");
    const runtime = body.runtimes[0];
    if (!runtime) {
      throw new Error("register runtime returned no runtimes");
    }
    this.createdRuntimeIds.push(runtime.id);
    return runtime;
  }

  async createAgent(data: {
    name: string;
    runtime_id: string;
    description?: string;
    instructions?: string;
    visibility?: "workspace" | "private";
  }): Promise<TestAgent> {
    const res = await this.authedFetch("/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: data.name,
        description: data.description ?? "AI-Me E2E worker",
        instructions: data.instructions ?? "Handle the assigned AI-Me test issue and report a concise result.",
        runtime_id: data.runtime_id,
        runtime_config: {},
        custom_env: {},
        custom_args: [],
        visibility: data.visibility ?? "workspace",
        max_concurrent_tasks: 1,
        model: "e2e-model",
      }),
    });
    const agent = await this.parseJSON<TestAgent>(res, "create agent");
    this.createdAgentIds.push(agent.id);
    return agent;
  }

  async createAIApproval(data: Record<string, unknown>): Promise<TestAIApproval> {
    const res = await this.authedFetch("/api/ai-me/approvals", {
      method: "POST",
      body: JSON.stringify(data),
    });
    const approval = await this.parseJSON<TestAIApproval>(res, "create AI approval");
    this.createdApprovalIds.push(approval.id);
    return approval;
  }

  async getAIApproval(id: string): Promise<TestAIApproval> {
    const res = await this.authedFetch(`/api/ai-me/approvals/${id}`);
    return this.parseJSON<TestAIApproval>(res, "get AI approval");
  }

  async claimTaskByRuntime(runtimeId: string): Promise<TestAgentTask> {
    const res = await this.authedFetch(`/api/daemon/runtimes/${runtimeId}/tasks/claim`, {
      method: "POST",
    });
    const body = await this.parseJSON<{ task: TestAgentTask | null }>(res, "claim task by runtime");
    if (!body.task) {
      throw new Error("runtime did not claim a task");
    }
    this.trackTask(body.task.id);
    return body.task;
  }

  async startTask(taskId: string): Promise<TestAgentTask> {
    const res = await this.authedFetch(`/api/daemon/tasks/${taskId}/start`, {
      method: "POST",
    });
    return this.parseJSON<TestAgentTask>(res, "start task");
  }

  async reportTaskMessages(taskId: string, messages: Array<Record<string, unknown>>) {
    const res = await this.authedFetch(`/api/daemon/tasks/${taskId}/messages`, {
      method: "POST",
      body: JSON.stringify({ messages }),
    });
    await this.parseJSON<{ status: string }>(res, "report task messages");
  }

  async completeTask(taskId: string, output: string): Promise<TestAgentTask> {
    const res = await this.authedFetch(`/api/daemon/tasks/${taskId}/complete`, {
      method: "POST",
      body: JSON.stringify({
        output,
        session_id: `aime-e2e-session-${Date.now()}`,
        work_dir: "D:/tmp/aime-e2e",
      }),
    });
    return this.parseJSON<TestAgentTask>(res, "complete task");
  }

  /** Clean up all issues created during this test. */
  async cleanup() {
    await this.cleanupAIMeArtifacts();

    for (const id of this.createdIssueIds) {
      try {
        await this.deleteIssue(id);
      } catch {
        /* ignore — may already be deleted */
      }
    }
    this.createdIssueIds = [];

    await this.cleanupAIMeActors();
  }

  getToken() {
    return this.token;
  }

  private async authedFetch(path: string, init?: RequestInit) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (this.workspaceSlug) headers["X-Workspace-Slug"] = this.workspaceSlug;
    else if (this.workspaceId) headers["X-Workspace-ID"] = this.workspaceId;
    return fetch(`${API_BASE}${path}`, { ...init, headers });
  }

  private trackTask(id: string | null | undefined) {
    if (id && !this.createdTaskIds.includes(id)) {
      this.createdTaskIds.push(id);
    }
  }

  private async parseJSON<T>(res: Response, label: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${label} failed: ${res.status} ${res.statusText} ${text}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async cleanupAIMeArtifacts() {
    const approvalIds = [...this.createdApprovalIds];
    const taskIds = [...this.createdTaskIds];
    if (approvalIds.length === 0 && taskIds.length === 0) return;

    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      if (approvalIds.length > 0) {
        await client.query("DELETE FROM ai_me_approval WHERE id = ANY($1::uuid[])", [approvalIds]);
      }
      if (taskIds.length > 0) {
        await client.query("DELETE FROM agent_task_queue WHERE id = ANY($1::uuid[])", [taskIds]);
      }
    } finally {
      await client.end();
      this.createdApprovalIds = [];
      this.createdTaskIds = [];
    }
  }

  private async cleanupAIMeActors() {
    const agentIds = [...this.createdAgentIds];
    const runtimeIds = [...this.createdRuntimeIds];
    if (agentIds.length === 0 && runtimeIds.length === 0) return;

    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      if (agentIds.length > 0) {
        await client.query("DELETE FROM agent WHERE id = ANY($1::uuid[])", [agentIds]);
      }
      if (runtimeIds.length > 0) {
        await client.query("DELETE FROM agent WHERE runtime_id = ANY($1::uuid[])", [runtimeIds]);
        await client.query("DELETE FROM agent_runtime WHERE id = ANY($1::uuid[])", [runtimeIds]);
      }
    } finally {
      await client.end();
      this.createdAgentIds = [];
      this.createdRuntimeIds = [];
    }
  }
}
