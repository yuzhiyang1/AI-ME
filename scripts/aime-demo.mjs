import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Client } from "pg";

const DEMO_SLUG = process.env.AI_ME_DEMO_WORKSPACE_SLUG || "ai-me-demo";
const DEMO_EMAIL = process.env.AI_ME_DEMO_EMAIL || "owner@ai-me.local";

const IDS = {
  taskQueued: "10000000-0000-4000-8000-000000000001",
  taskRunning: "10000000-0000-4000-8000-000000000002",
  taskCompleted: "10000000-0000-4000-8000-000000000003",
  inboxRefund: "20000000-0000-4000-8000-000000000001",
  inboxBuild: "20000000-0000-4000-8000-000000000002",
  memorySourceUser: "30000000-0000-4000-8000-000000000001",
  memorySourceIssue: "30000000-0000-4000-8000-000000000002",
  memoryActive: "31000000-0000-4000-8000-000000000001",
  memoryCandidate: "31000000-0000-4000-8000-000000000002",
  memoryEvidenceActive: "32000000-0000-4000-8000-000000000001",
  memoryEvidenceCandidate: "32000000-0000-4000-8000-000000000002",
  knowledgeDoc: "33000000-0000-4000-8000-000000000001",
  approvalAssign: "40000000-0000-4000-8000-000000000001",
  approvalReply: "40000000-0000-4000-8000-000000000002",
  approvalMemory: "40000000-0000-4000-8000-000000000003",
  approvalEvidenceAssign: "41000000-0000-4000-8000-000000000001",
  approvalEvidenceReply: "41000000-0000-4000-8000-000000000002",
  approvalEvidenceMemory: "41000000-0000-4000-8000-000000000003",
  approvalEventAssign: "42000000-0000-4000-8000-000000000001",
  approvalEventReply: "42000000-0000-4000-8000-000000000002",
  approvalEventMemory: "42000000-0000-4000-8000-000000000003",
  activitySignal: "50000000-0000-4000-8000-000000000001",
  activityApproval: "50000000-0000-4000-8000-000000000002",
};

const DEMO_ISSUES = {
  refund: 170,
  latency: 171,
  memory: 172,
};

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function loadRuntimeEnv() {
  const envFile =
    process.env.ENV_FILE ||
    (fs.existsSync(path.resolve(".env")) ? ".env" : ".env.worktree");
  const parsed = readEnvFile(path.resolve(envFile));

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  const user = process.env.POSTGRES_USER || "multica";
  const password = process.env.POSTGRES_PASSWORD || "multica";
  const host = process.env.POSTGRES_HOST || "localhost";
  const port = process.env.POSTGRES_PORT || "5432";
  const db = process.env.POSTGRES_DB || "multica";
  const databaseUrl =
    process.env.DATABASE_URL ||
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${db}?sslmode=disable`;

  return { envFile, databaseUrl };
}

function assertLocalDatabase(databaseUrl) {
  if (process.env.AI_ME_ALLOW_REMOTE_SEED === "true") return;

  const url = new URL(databaseUrl);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!localHosts.has(url.hostname)) {
    throw new Error(
      `Refusing to write demo data to non-local database host "${url.hostname}". Set AI_ME_ALLOW_REMOTE_SEED=true to override.`,
    );
  }
}

function asJson(value) {
  return JSON.stringify(value);
}

async function queryOne(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0];
}

async function getOrCreateDemoUsers(client) {
  const existing = await client.query(
    `SELECT id, name, email FROM "user" ORDER BY created_at ASC, id ASC`,
  );
  if (existing.rows.length > 0) {
    return existing.rows;
  }

  const user = await queryOne(
    client,
    `
      INSERT INTO "user" (name, email, language, starter_content_state)
      VALUES ($1, $2, 'zh-CN', 'completed')
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name,
        language = EXCLUDED.language,
        starter_content_state = EXCLUDED.starter_content_state,
        updated_at = now()
      RETURNING id, name, email
    `,
    ["AI-ME Owner", DEMO_EMAIL],
  );
  return [user];
}

async function upsertWorkspace(client) {
  return queryOne(
    client,
    `
      INSERT INTO workspace (
        name, slug, description, context, settings, repos,
        issue_prefix, issue_counter
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'AIM', $7)
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        context = EXCLUDED.context,
        settings = EXCLUDED.settings,
        repos = EXCLUDED.repos,
        issue_prefix = EXCLUDED.issue_prefix,
        issue_counter = GREATEST(workspace.issue_counter, EXCLUDED.issue_counter),
        updated_at = now()
      RETURNING id, slug, name
    `,
    [
      "AI-ME 本地演示",
      DEMO_SLUG,
      "用于本地验证 AI-ME 驾驶舱、审批、例外收件箱、记忆与 AI 员工调度闭环。",
      "AI-ME v0.1 demo workspace. 所有高风险对外动作必须先进入审批中心。",
      asJson({
        ai_me_demo: true,
        ai_me_status: "development",
      }),
      asJson([
        {
          name: "AI-ME",
          url: "https://github.com/yuzhiyang1/AI-ME",
          kind: "github",
        },
      ]),
      Math.max(...Object.values(DEMO_ISSUES)),
    ],
  );
}

async function upsertMembers(client, workspaceId, users) {
  for (const [index, user] of users.entries()) {
    await client.query(
      `
        INSERT INTO member (workspace_id, user_id, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET
          role = CASE WHEN member.role = 'owner' THEN member.role ELSE EXCLUDED.role END
      `,
      [workspaceId, user.id, index === 0 ? "owner" : "member"],
    );
  }
}

async function upsertRuntime(client, workspaceId, ownerId, spec) {
  return queryOne(
    client,
    `
      INSERT INTO agent_runtime (
        workspace_id, daemon_id, name, runtime_mode, provider, status,
        device_info, metadata, last_seen_at, owner_id
      )
      VALUES ($1, $2, $3, 'local', $4, $5, $6, $7::jsonb, now(), $8)
      ON CONFLICT (workspace_id, daemon_id, provider) DO UPDATE SET
        name = EXCLUDED.name,
        runtime_mode = EXCLUDED.runtime_mode,
        status = EXCLUDED.status,
        device_info = EXCLUDED.device_info,
        metadata = EXCLUDED.metadata,
        last_seen_at = EXCLUDED.last_seen_at,
        owner_id = EXCLUDED.owner_id,
        updated_at = now()
      RETURNING id
    `,
    [
      workspaceId,
      spec.daemonId,
      spec.name,
      spec.provider,
      spec.status,
      spec.deviceInfo,
      asJson({ ai_me_demo: true, role: spec.role }),
      ownerId,
    ],
  );
}

async function upsertAgent(client, workspaceId, ownerId, runtimeId, spec) {
  return queryOne(
    client,
    `
      INSERT INTO agent (
        workspace_id, name, description, avatar_url, runtime_mode,
        runtime_config, runtime_id, visibility, status, max_concurrent_tasks,
        owner_id, instructions, custom_env, custom_args, mcp_config, model,
        default_code_context
      )
      VALUES (
        $1, $2, $3, NULL, 'local',
        $4::jsonb, $5, 'workspace', $6, $7,
        $8, $9, '{}'::jsonb, '[]'::jsonb, NULL, $10,
        $11::jsonb
      )
      ON CONFLICT ON CONSTRAINT agent_workspace_name_unique DO UPDATE SET
        description = EXCLUDED.description,
        runtime_config = EXCLUDED.runtime_config,
        runtime_id = EXCLUDED.runtime_id,
        visibility = EXCLUDED.visibility,
        status = EXCLUDED.status,
        max_concurrent_tasks = EXCLUDED.max_concurrent_tasks,
        owner_id = EXCLUDED.owner_id,
        instructions = EXCLUDED.instructions,
        model = EXCLUDED.model,
        default_code_context = EXCLUDED.default_code_context,
        archived_at = NULL,
        archived_by = NULL,
        updated_at = now()
      RETURNING id
    `,
    [
      workspaceId,
      spec.name,
      spec.description,
      asJson({ ai_me_demo: true, provider: spec.provider }),
      runtimeId,
      spec.status,
      spec.maxConcurrentTasks,
      ownerId,
      spec.instructions,
      spec.model,
      asJson(spec.defaultCodeContext),
    ],
  );
}

async function upsertIssue(client, workspaceId, ownerId, spec) {
  return queryOne(
    client,
    `
      INSERT INTO issue (
        workspace_id, title, description, status, priority,
        assignee_type, assignee_id, creator_type, creator_id,
        position, number, code_context
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, 'member', $8,
        $9, $10, $11::jsonb
      )
      ON CONFLICT ON CONSTRAINT uq_issue_workspace_number DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        priority = EXCLUDED.priority,
        assignee_type = EXCLUDED.assignee_type,
        assignee_id = EXCLUDED.assignee_id,
        creator_type = EXCLUDED.creator_type,
        creator_id = EXCLUDED.creator_id,
        position = EXCLUDED.position,
        code_context = EXCLUDED.code_context,
        updated_at = now()
      RETURNING id, number
    `,
    [
      workspaceId,
      spec.title,
      spec.description,
      spec.status,
      spec.priority,
      spec.assigneeType,
      spec.assigneeId,
      ownerId,
      spec.position,
      spec.number,
      asJson(spec.codeContext),
    ],
  );
}

async function upsertTask(client, spec) {
  await client.query(
    `
      INSERT INTO agent_task_queue (
        id, agent_id, runtime_id, issue_id, status, priority,
        dispatched_at, started_at, completed_at, result, error,
        context, trigger_summary, force_fresh_session, created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10::jsonb, $11,
        $12::jsonb, $13, $14, now() - ($15::text)::interval
      )
      ON CONFLICT (id) DO UPDATE SET
        agent_id = EXCLUDED.agent_id,
        runtime_id = EXCLUDED.runtime_id,
        issue_id = EXCLUDED.issue_id,
        status = EXCLUDED.status,
        priority = EXCLUDED.priority,
        dispatched_at = EXCLUDED.dispatched_at,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at,
        result = EXCLUDED.result,
        error = EXCLUDED.error,
        context = EXCLUDED.context,
        trigger_summary = EXCLUDED.trigger_summary,
        force_fresh_session = EXCLUDED.force_fresh_session,
        created_at = EXCLUDED.created_at
    `,
    [
      spec.id,
      spec.agentId,
      spec.runtimeId,
      spec.issueId,
      spec.status,
      spec.priority,
      spec.dispatchedAt,
      spec.startedAt,
      spec.completedAt,
      asJson(spec.result),
      spec.error,
      asJson(spec.context),
      spec.triggerSummary,
      spec.forceFreshSession,
      spec.age,
    ],
  );
}

async function upsertInboxItem(client, spec) {
  await client.query(
    `
      INSERT INTO inbox_item (
        id, workspace_id, recipient_type, recipient_id, type, severity,
        issue_id, title, body, read, archived, actor_type, actor_id, details,
        created_at
      )
      VALUES (
        $1, $2, 'member', $3, $4, $5,
        $6, $7, $8, $9, false, $10, $11, $12::jsonb,
        now() - ($13::text)::interval
      )
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        recipient_type = EXCLUDED.recipient_type,
        recipient_id = EXCLUDED.recipient_id,
        type = EXCLUDED.type,
        severity = EXCLUDED.severity,
        issue_id = EXCLUDED.issue_id,
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        read = EXCLUDED.read,
        archived = EXCLUDED.archived,
        actor_type = EXCLUDED.actor_type,
        actor_id = EXCLUDED.actor_id,
        details = EXCLUDED.details,
        created_at = EXCLUDED.created_at
    `,
    [
      spec.id,
      spec.workspaceId,
      spec.recipientId,
      spec.type,
      spec.severity,
      spec.issueId,
      spec.title,
      spec.body,
      spec.read,
      spec.actorType,
      spec.actorId,
      asJson(spec.details),
      spec.age,
    ],
  );
}

async function upsertMemorySource(client, spec) {
  await client.query(
    `
      INSERT INTO memory_source (
        id, workspace_id, source_type, source_ref_id, source_url,
        title, excerpt, metadata, captured_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        source_type = EXCLUDED.source_type,
        source_ref_id = EXCLUDED.source_ref_id,
        source_url = EXCLUDED.source_url,
        title = EXCLUDED.title,
        excerpt = EXCLUDED.excerpt,
        metadata = EXCLUDED.metadata,
        captured_at = EXCLUDED.captured_at
    `,
    [
      spec.id,
      spec.workspaceId,
      spec.sourceType,
      spec.sourceRefId,
      spec.sourceUrl,
      spec.title,
      spec.excerpt,
      asJson(spec.metadata),
    ],
  );
}

async function upsertMemoryEntry(client, spec) {
  await client.query(
    `
      INSERT INTO memory_entry (
        id, workspace_id, owner_user_id, type, category, title,
        content, summary, status, confidence, sensitivity, scope_type,
        scope_ref_id, external_use_policy, source_mode, created_by_type,
        created_by_id, verified_by, verified_at, last_used_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16,
        $17, $18, $19, $20
      )
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        owner_user_id = EXCLUDED.owner_user_id,
        type = EXCLUDED.type,
        category = EXCLUDED.category,
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        summary = EXCLUDED.summary,
        status = EXCLUDED.status,
        confidence = EXCLUDED.confidence,
        sensitivity = EXCLUDED.sensitivity,
        scope_type = EXCLUDED.scope_type,
        scope_ref_id = EXCLUDED.scope_ref_id,
        external_use_policy = EXCLUDED.external_use_policy,
        source_mode = EXCLUDED.source_mode,
        created_by_type = EXCLUDED.created_by_type,
        created_by_id = EXCLUDED.created_by_id,
        verified_by = EXCLUDED.verified_by,
        verified_at = EXCLUDED.verified_at,
        last_used_at = EXCLUDED.last_used_at,
        archived_at = NULL,
        updated_at = now()
    `,
    [
      spec.id,
      spec.workspaceId,
      spec.ownerUserId,
      spec.type,
      spec.category,
      spec.title,
      spec.content,
      spec.summary,
      spec.status,
      spec.confidence,
      spec.sensitivity,
      spec.scopeType,
      spec.scopeRefId,
      spec.externalUsePolicy,
      spec.sourceMode,
      spec.createdByType,
      spec.createdById,
      spec.verifiedBy,
      spec.verifiedAt,
      spec.lastUsedAt,
    ],
  );
}

async function upsertMemoryEvidence(client, spec) {
  await client.query(
    `
      INSERT INTO memory_evidence (
        id, memory_id, source_id, excerpt, location, confidence
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        memory_id = EXCLUDED.memory_id,
        source_id = EXCLUDED.source_id,
        excerpt = EXCLUDED.excerpt,
        location = EXCLUDED.location,
        confidence = EXCLUDED.confidence
    `,
    [spec.id, spec.memoryId, spec.sourceId, spec.excerpt, spec.location, spec.confidence],
  );
}

async function upsertKnowledgeDocument(client, spec) {
  await client.query(
    `
      INSERT INTO knowledge_document (
        id, workspace_id, title, source_type, source_url, status,
        imported_by, metadata, last_indexed_at
      )
      VALUES ($1, $2, $3, $4, $5, 'ready', $6, $7::jsonb, now())
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        title = EXCLUDED.title,
        source_type = EXCLUDED.source_type,
        source_url = EXCLUDED.source_url,
        status = EXCLUDED.status,
        imported_by = EXCLUDED.imported_by,
        metadata = EXCLUDED.metadata,
        last_indexed_at = EXCLUDED.last_indexed_at,
        updated_at = now()
    `,
    [
      spec.id,
      spec.workspaceId,
      spec.title,
      spec.sourceType,
      spec.sourceUrl,
      spec.importedBy,
      asJson(spec.metadata),
    ],
  );
}

async function upsertApproval(client, spec) {
  await client.query(
    `
      INSERT INTO ai_me_approval (
        id, workspace_id, requester_user_id, source_type, source_ref_id,
        source_url, issue_id, inbox_item_id, task_queue_id, memory_id,
        title, summary, status, risk_level, confidence, reversibility,
        action_type, action_title, action_description, original_payload,
        final_payload, ai_reasoning_summary, execution_status, execution_error,
        expires_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20::jsonb,
        $21::jsonb, $22, 'not_started', '',
        now() + interval '3 days'
      )
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        requester_user_id = EXCLUDED.requester_user_id,
        source_type = EXCLUDED.source_type,
        source_ref_id = EXCLUDED.source_ref_id,
        source_url = EXCLUDED.source_url,
        issue_id = EXCLUDED.issue_id,
        inbox_item_id = EXCLUDED.inbox_item_id,
        task_queue_id = EXCLUDED.task_queue_id,
        memory_id = EXCLUDED.memory_id,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        status = EXCLUDED.status,
        risk_level = EXCLUDED.risk_level,
        confidence = EXCLUDED.confidence,
        reversibility = EXCLUDED.reversibility,
        action_type = EXCLUDED.action_type,
        action_title = EXCLUDED.action_title,
        action_description = EXCLUDED.action_description,
        original_payload = EXCLUDED.original_payload,
        final_payload = EXCLUDED.final_payload,
        ai_reasoning_summary = EXCLUDED.ai_reasoning_summary,
        approval_note = '',
        rejection_reason = '',
        approved_by = NULL,
        approved_at = NULL,
        rejected_by = NULL,
        rejected_at = NULL,
        observed_by = NULL,
        observed_at = NULL,
        taken_over_by = NULL,
        taken_over_at = NULL,
        executed_at = NULL,
        execution_status = EXCLUDED.execution_status,
        execution_error = EXCLUDED.execution_error,
        created_issue_id = NULL,
        created_task_id = NULL,
        created_comment_id = NULL,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    `,
    [
      spec.id,
      spec.workspaceId,
      spec.requesterUserId,
      spec.sourceType,
      spec.sourceRefId,
      spec.sourceUrl,
      spec.issueId,
      spec.inboxItemId,
      spec.taskQueueId,
      spec.memoryId,
      spec.title,
      spec.summary,
      spec.status,
      spec.riskLevel,
      spec.confidence,
      spec.reversibility,
      spec.actionType,
      spec.actionTitle,
      spec.actionDescription,
      asJson(spec.originalPayload),
      asJson(spec.finalPayload),
      spec.aiReasoningSummary,
    ],
  );
}

async function upsertApprovalEvidence(client, spec) {
  await client.query(
    `
      INSERT INTO ai_me_approval_evidence (
        id, approval_id, workspace_id, evidence_type, label,
        ref_id, source_url, quote, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        approval_id = EXCLUDED.approval_id,
        workspace_id = EXCLUDED.workspace_id,
        evidence_type = EXCLUDED.evidence_type,
        label = EXCLUDED.label,
        ref_id = EXCLUDED.ref_id,
        source_url = EXCLUDED.source_url,
        quote = EXCLUDED.quote,
        metadata = EXCLUDED.metadata
    `,
    [
      spec.id,
      spec.approvalId,
      spec.workspaceId,
      spec.evidenceType,
      spec.label,
      spec.refId,
      spec.sourceUrl,
      spec.quote,
      asJson(spec.metadata),
    ],
  );
}

async function upsertApprovalEvent(client, spec) {
  await client.query(
    `
      INSERT INTO ai_me_approval_event (
        id, approval_id, workspace_id, actor_type, actor_id, event_type,
        from_status, to_status, payload
      )
      VALUES ($1, $2, $3, $4, $5, 'created', NULL, 'pending', $6::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        approval_id = EXCLUDED.approval_id,
        workspace_id = EXCLUDED.workspace_id,
        actor_type = EXCLUDED.actor_type,
        actor_id = EXCLUDED.actor_id,
        event_type = EXCLUDED.event_type,
        from_status = EXCLUDED.from_status,
        to_status = EXCLUDED.to_status,
        payload = EXCLUDED.payload
    `,
    [
      spec.id,
      spec.approvalId,
      spec.workspaceId,
      spec.actorType,
      spec.actorId,
      asJson(spec.payload),
    ],
  );
}

async function upsertActivity(client, spec) {
  await client.query(
    `
      INSERT INTO activity_log (
        id, workspace_id, issue_id, actor_type, actor_id, action, details, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now() - ($8::text)::interval)
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        issue_id = EXCLUDED.issue_id,
        actor_type = EXCLUDED.actor_type,
        actor_id = EXCLUDED.actor_id,
        action = EXCLUDED.action,
        details = EXCLUDED.details,
        created_at = EXCLUDED.created_at
    `,
    [
      spec.id,
      spec.workspaceId,
      spec.issueId,
      spec.actorType,
      spec.actorId,
      spec.action,
      asJson(spec.details),
      spec.age,
    ],
  );
}

async function seed(client) {
  await client.query("BEGIN");
  try {
    const users = await getOrCreateDemoUsers(client);
    const owner = users[0];
    const workspace = await upsertWorkspace(client);
    await upsertMembers(client, workspace.id, users);

    const codexRuntime = await upsertRuntime(client, workspace.id, owner.id, {
      daemonId: "ai-me-demo-codex",
      name: "AI-ME Demo Codex Runtime",
      provider: "codex_cli",
      status: "online",
      deviceInfo: "local demo runtime",
      role: "codex-worker",
    });
    const claudeRuntime = await upsertRuntime(client, workspace.id, owner.id, {
      daemonId: "ai-me-demo-claude",
      name: "AI-ME Demo Claude Runtime",
      provider: "claude_code_cli",
      status: "online",
      deviceInfo: "local demo runtime",
      role: "claude-worker",
    });

    const codex = await upsertAgent(client, workspace.id, owner.id, codexRuntime.id, {
      name: "Codex Worker #1",
      provider: "codex_cli",
      description: "代码定位、实现、测试与本地验证",
      status: "idle",
      maxConcurrentTasks: 1,
      model: "codex-local",
      instructions: "负责代码修改、测试和提交前验证。遇到对外动作必须等待 AI-ME 审批。",
      defaultCodeContext: {
        type: "repo",
        path: "D:/workspace/Helm",
        summary: "AI-ME current repository",
      },
    });
    const claude = await upsertAgent(client, workspace.id, owner.id, claudeRuntime.id, {
      name: "Claude Worker #1",
      provider: "claude_code_cli",
      description: "方案分析、复杂 Review 与文档整理",
      status: "working",
      maxConcurrentTasks: 1,
      model: "claude-code-local",
      instructions: "负责复杂方案分析和文档化，输出必须保留证据与风险判断。",
      defaultCodeContext: {
        type: "repo",
        path: "D:/workspace/Helm",
        summary: "AI-ME product and backend docs",
      },
    });

    const refundIssue = await upsertIssue(client, workspace.id, owner.id, {
      number: DEMO_ISSUES.refund,
      title: "是否对外回复退款问题",
      description:
        "飞书里有一条用户退款追问，AI-ME 已生成回复草稿，但对外发送前必须经过审批。",
      status: "in_review",
      priority: "urgent",
      assigneeType: "agent",
      assigneeId: codex.id,
      position: 100,
      codeContext: {
        source: "ai-me-demo",
        service: "payment-service",
      },
    });
    const latencyIssue = await upsertIssue(client, workspace.id, owner.id, {
      number: DEMO_ISSUES.latency,
      title: "分析退款状态接口响应时间",
      description:
        "Codex Worker 需要检查 payment-service 的接口日志和慢查询，给出优化建议。",
      status: "in_progress",
      priority: "high",
      assigneeType: "agent",
      assigneeId: codex.id,
      position: 200,
      codeContext: {
        source: "ai-me-demo",
        service: "payment-service",
      },
    });
    const memoryIssue = await upsertIssue(client, workspace.id, owner.id, {
      number: DEMO_ISSUES.memory,
      title: "确认 AI-ME 记忆候选：审批优先",
      description:
        "AI-ME 从对话中推断出一个偏好：对外发送、合并、生产动作都必须先审批。",
      status: "todo",
      priority: "medium",
      assigneeType: null,
      assigneeId: null,
      position: 300,
      codeContext: {
        source: "ai-me-demo",
      },
    });

    await upsertTask(client, {
      id: IDS.taskQueued,
      agentId: codex.id,
      runtimeId: codexRuntime.id,
      issueId: latencyIssue.id,
      status: "queued",
      priority: 90,
      dispatchedAt: null,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      context: {
        type: "approval_assign_worker",
        demo: true,
        issue_number: DEMO_ISSUES.latency,
      },
      triggerSummary: "AI-ME 批准后分配 Codex Worker 检查接口响应时间。",
      forceFreshSession: false,
      age: "18 minutes",
    });
    await upsertTask(client, {
      id: IDS.taskRunning,
      agentId: claude.id,
      runtimeId: claudeRuntime.id,
      issueId: memoryIssue.id,
      status: "running",
      priority: 60,
      dispatchedAt: new Date(Date.now() - 12 * 60 * 1000),
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
      completedAt: null,
      result: null,
      error: null,
      context: {
        type: "memory_review",
        demo: true,
      },
      triggerSummary: "整理 AI-ME 记忆候选的证据和适用范围。",
      forceFreshSession: false,
      age: "12 minutes",
    });
    await upsertTask(client, {
      id: IDS.taskCompleted,
      agentId: codex.id,
      runtimeId: codexRuntime.id,
      issueId: refundIssue.id,
      status: "completed",
      priority: 40,
      dispatchedAt: new Date(Date.now() - 75 * 60 * 1000),
      startedAt: new Date(Date.now() - 70 * 60 * 1000),
      completedAt: new Date(Date.now() - 55 * 60 * 1000),
      result: {
        summary: "已生成退款回复草稿，等待审批后对外发送。",
        next_step: "approval_required",
      },
      error: null,
      context: {
        type: "draft_external_reply",
        demo: true,
      },
      triggerSummary: "根据飞书消息生成退款状态回复草稿。",
      forceFreshSession: false,
      age: "75 minutes",
    });

    await upsertInboxItem(client, {
      id: IDS.inboxRefund,
      workspaceId: workspace.id,
      recipientId: owner.id,
      type: "external_reply_approval",
      severity: "action_required",
      issueId: refundIssue.id,
      title: "飞书退款追问需要审批回复",
      body: "用户询问退款为什么一直未处理，AI-ME 已生成草稿，需要你确认是否对外发送。",
      read: false,
      actorType: "agent",
      actorId: claude.id,
      details: {
        ai_me_demo: true,
        source: "feishu",
        approval_id: IDS.approvalReply,
      },
      age: "25 minutes",
    });
    await upsertInboxItem(client, {
      id: IDS.inboxBuild,
      workspaceId: workspace.id,
      recipientId: owner.id,
      type: "agent_task_attention",
      severity: "attention",
      issueId: latencyIssue.id,
      title: "Codex Worker 已排队等待执行",
      body: "接口响应时间分析任务已进入队列。当前 runtime 在线，但需要等待前一个任务释放。",
      read: false,
      actorType: "agent",
      actorId: codex.id,
      details: {
        ai_me_demo: true,
        task_id: IDS.taskQueued,
      },
      age: "18 minutes",
    });

    await upsertMemorySource(client, {
      id: IDS.memorySourceUser,
      workspaceId: workspace.id,
      sourceType: "manual",
      sourceRefId: null,
      sourceUrl: null,
      title: "AI-ME 本地演示偏好",
      excerpt: "用户希望 AI-ME 用中文说明，先审批再执行高风险动作。",
      metadata: {
        ai_me_demo: true,
      },
    });
    await upsertMemorySource(client, {
      id: IDS.memorySourceIssue,
      workspaceId: workspace.id,
      sourceType: "issue",
      sourceRefId: memoryIssue.id,
      sourceUrl: null,
      title: "审批优先 issue",
      excerpt: "AI-ME 从对话中推断出一个偏好：对外发送、合并、生产动作都必须先审批。",
      metadata: {
        ai_me_demo: true,
        issue_number: DEMO_ISSUES.memory,
      },
    });
    await upsertMemoryEntry(client, {
      id: IDS.memoryActive,
      workspaceId: workspace.id,
      ownerUserId: owner.id,
      type: "preference",
      category: "沟通风格",
      title: "默认使用中文说明项目进展",
      content: "用户偏好中文输出，项目介绍、规划、验收结果都应优先用中文表达。",
      summary: "中文优先，说明要具体、可执行。",
      status: "active",
      confidence: 0.95,
      sensitivity: "normal",
      scopeType: "workspace",
      scopeRefId: workspace.id,
      externalUsePolicy: "with_approval",
      sourceMode: "manual",
      createdByType: "member",
      createdById: owner.id,
      verifiedBy: owner.id,
      verifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      lastUsedAt: new Date(Date.now() - 45 * 60 * 1000),
    });
    await upsertMemoryEntry(client, {
      id: IDS.memoryCandidate,
      workspaceId: workspace.id,
      ownerUserId: owner.id,
      type: "rule",
      category: "安全边界",
      title: "对外动作必须先审批",
      content:
        "AI-ME 可以生成对外回复草稿、任务建议和员工分配建议，但发送消息、合并代码、生产变更前必须进入审批中心。",
      summary: "高风险动作先审批，不能自动越权执行。",
      status: "candidate",
      confidence: 0.9,
      sensitivity: "restricted",
      scopeType: "workspace",
      scopeRefId: workspace.id,
      externalUsePolicy: "never",
      sourceMode: "inferred",
      createdByType: "system",
      createdById: null,
      verifiedBy: null,
      verifiedAt: null,
      lastUsedAt: null,
    });
    await upsertMemoryEvidence(client, {
      id: IDS.memoryEvidenceActive,
      memoryId: IDS.memoryActive,
      sourceId: IDS.memorySourceUser,
      excerpt: "项目说明和用户反馈都要求中文表达。",
      location: "demo/preferences#language",
      confidence: 0.95,
    });
    await upsertMemoryEvidence(client, {
      id: IDS.memoryEvidenceCandidate,
      memoryId: IDS.memoryCandidate,
      sourceId: IDS.memorySourceIssue,
      excerpt: "对外发送、重要数据修改、代码合并、生产动作和用户承诺都不应绕过审批链路。",
      location: "AIM-172",
      confidence: 0.9,
    });
    await upsertKnowledgeDocument(client, {
      id: IDS.knowledgeDoc,
      workspaceId: workspace.id,
      title: "AI-ME v0.1 本地演示说明",
      sourceType: "manual",
      sourceUrl: "docs/ai-me-demo.md",
      importedBy: owner.id,
      metadata: {
        ai_me_demo: true,
        purpose: "local-demo-baseline",
      },
    });

    await upsertApproval(client, {
      id: IDS.approvalAssign,
      workspaceId: workspace.id,
      requesterUserId: owner.id,
      sourceType: "ai_me_think",
      sourceRefId: `AIM-${DEMO_ISSUES.latency}`,
      sourceUrl: null,
      issueId: latencyIssue.id,
      inboxItemId: IDS.inboxBuild,
      taskQueueId: null,
      memoryId: null,
      title: "分配 Codex Worker 分析退款接口响应",
      summary: "AI-ME 建议让 Codex Worker 检查 payment-service 的退款状态接口慢响应。",
      status: "pending",
      riskLevel: "medium",
      confidence: 0.86,
      reversibility: "reversible",
      actionType: "assign_worker",
      actionTitle: "分配 Codex Worker",
      actionDescription: "批准后将 issue 分配给 Codex Worker，并写入 agent_task_queue。",
      originalPayload: {
        issue_id: latencyIssue.id,
        issue_number: DEMO_ISSUES.latency,
        suggested_agent: "Codex Worker #1",
      },
      finalPayload: {
        issue_id: latencyIssue.id,
        target_agent_id: codex.id,
        instructions: "检查 payment-service 退款状态接口响应时间，输出原因、证据和修复建议。",
        priority: 90,
      },
      aiReasoningSummary:
        "问题涉及代码和日志定位，适合交给 Codex Worker；动作可撤销，风险为中。",
    });
    await upsertApproval(client, {
      id: IDS.approvalReply,
      workspaceId: workspace.id,
      requesterUserId: owner.id,
      sourceType: "feishu",
      sourceRefId: "feishu-demo-refund-message",
      sourceUrl: null,
      issueId: refundIssue.id,
      inboxItemId: IDS.inboxRefund,
      taskQueueId: IDS.taskCompleted,
      memoryId: null,
      title: "是否对外回复退款问题",
      summary: "AI-ME 已根据退款状态生成回复草稿，发送前需要你确认语气和承诺范围。",
      status: "pending",
      riskLevel: "high",
      confidence: 0.78,
      reversibility: "partially_reversible",
      actionType: "send_external_message",
      actionTitle: "发送飞书回复",
      actionDescription: "批准后才允许把最终草稿发送到原飞书会话。",
      originalPayload: {
        source: "feishu",
        message: "退款一直未处理，帮我看下现在是什么情况？",
      },
      finalPayload: {
        channel: "feishu",
        recipient: "demo-user",
        draft_text:
          "您好，退款状态我已经在跟进。当前还需要确认支付服务的回调状态，我会先核对记录，再给您明确结果。",
      },
      aiReasoningSummary:
        "这是对外表达且涉及退款承诺，必须由用户确认后才能发送。",
    });
    await upsertApproval(client, {
      id: IDS.approvalMemory,
      workspaceId: workspace.id,
      requesterUserId: owner.id,
      sourceType: "memory",
      sourceRefId: IDS.memoryCandidate,
      sourceUrl: null,
      issueId: memoryIssue.id,
      inboxItemId: null,
      taskQueueId: IDS.taskRunning,
      memoryId: IDS.memoryCandidate,
      title: "确认候选记忆：对外动作必须先审批",
      summary: "AI-ME 从项目讨论中总结出一条安全边界，需要你确认后才进入长期记忆。",
      status: "pending",
      riskLevel: "low",
      confidence: 0.9,
      reversibility: "reversible",
      actionType: "confirm_memory",
      actionTitle: "确认候选记忆",
      actionDescription: "批准后将候选记忆转为 active，供 AI-ME 后续判断风险时检索。",
      originalPayload: {
        memory_id: IDS.memoryCandidate,
        status: "candidate",
      },
      finalPayload: {
        memory_id: IDS.memoryCandidate,
        status: "active",
        external_use_policy: "never",
      },
      aiReasoningSummary:
        "这条记忆会影响 AI-ME 的执行边界，但不涉及对外发送，风险较低。",
    });

    await upsertApprovalEvidence(client, {
      id: IDS.approvalEvidenceAssign,
      approvalId: IDS.approvalAssign,
      workspaceId: workspace.id,
      evidenceType: "issue",
      label: `AIM-${DEMO_ISSUES.latency}`,
      refId: latencyIssue.id,
      sourceUrl: null,
      quote: "Codex Worker 需要检查 payment-service 的接口日志和慢查询，给出优化建议。",
      metadata: { ai_me_demo: true },
    });
    await upsertApprovalEvidence(client, {
      id: IDS.approvalEvidenceReply,
      approvalId: IDS.approvalReply,
      workspaceId: workspace.id,
      evidenceType: "feishu",
      label: "飞书原始消息",
      refId: "feishu-demo-refund-message",
      sourceUrl: null,
      quote: "退款一直未处理，帮我看下现在是什么情况？",
      metadata: { ai_me_demo: true },
    });
    await upsertApprovalEvidence(client, {
      id: IDS.approvalEvidenceMemory,
      approvalId: IDS.approvalMemory,
      workspaceId: workspace.id,
      evidenceType: "memory",
      label: "候选记忆",
      refId: IDS.memoryCandidate,
      sourceUrl: null,
      quote: "对外发送、合并、生产动作都必须先审批。",
      metadata: { ai_me_demo: true },
    });

    await upsertApprovalEvent(client, {
      id: IDS.approvalEventAssign,
      approvalId: IDS.approvalAssign,
      workspaceId: workspace.id,
      actorType: "ai_me",
      actorId: null,
      payload: { ai_me_demo: true, reason: "demo seed created approval" },
    });
    await upsertApprovalEvent(client, {
      id: IDS.approvalEventReply,
      approvalId: IDS.approvalReply,
      workspaceId: workspace.id,
      actorType: "ai_me",
      actorId: null,
      payload: { ai_me_demo: true, reason: "demo seed created approval" },
    });
    await upsertApprovalEvent(client, {
      id: IDS.approvalEventMemory,
      approvalId: IDS.approvalMemory,
      workspaceId: workspace.id,
      actorType: "ai_me",
      actorId: null,
      payload: { ai_me_demo: true, reason: "demo seed created approval" },
    });

    await upsertActivity(client, {
      id: IDS.activitySignal,
      workspaceId: workspace.id,
      issueId: refundIssue.id,
      actorType: "system",
      actorId: null,
      action: "ai_me_demo_signal_received",
      details: {
        ai_me_demo: true,
        source: "feishu",
        inbox_item_id: IDS.inboxRefund,
      },
      age: "25 minutes",
    });
    await upsertActivity(client, {
      id: IDS.activityApproval,
      workspaceId: workspace.id,
      issueId: latencyIssue.id,
      actorType: "system",
      actorId: null,
      action: "ai_me_demo_approval_created",
      details: {
        ai_me_demo: true,
        approval_id: IDS.approvalAssign,
      },
      age: "18 minutes",
    });

    await client.query("COMMIT");
    return {
      workspace,
      owner,
      agents: [codex, claude],
      issues: [refundIssue, latencyIssue, memoryIssue],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function smoke(client) {
  const workspace = await queryOne(client, `SELECT id, slug, name FROM workspace WHERE slug = $1`, [
    DEMO_SLUG,
  ]);
  if (!workspace) {
    throw new Error(`AI-ME demo workspace "${DEMO_SLUG}" was not found. Run pnpm aime:seed first.`);
  }

  const checks = [
    {
      name: "members",
      sql: `SELECT count(*)::int AS count FROM member WHERE workspace_id = $1`,
      min: 1,
    },
    {
      name: "agents",
      sql: `SELECT count(*)::int AS count FROM agent WHERE workspace_id = $1 AND archived_at IS NULL`,
      min: 2,
    },
    {
      name: "issues",
      sql: `SELECT count(*)::int AS count FROM issue WHERE workspace_id = $1 AND number = ANY($2::int[])`,
      params: [Object.values(DEMO_ISSUES)],
      min: 3,
    },
    {
      name: "pending approvals",
      sql: `SELECT count(*)::int AS count FROM ai_me_approval WHERE workspace_id = $1 AND status = 'pending'`,
      min: 3,
    },
    {
      name: "approval evidence",
      sql: `SELECT count(*)::int AS count FROM ai_me_approval_evidence WHERE workspace_id = $1`,
      min: 3,
    },
    {
      name: "inbox items",
      sql: `SELECT count(*)::int AS count FROM inbox_item WHERE workspace_id = $1 AND archived = false`,
      min: 2,
    },
    {
      name: "agent tasks",
      sql: `
        SELECT count(*)::int AS count
        FROM agent_task_queue t
        JOIN agent a ON a.id = t.agent_id
        WHERE a.workspace_id = $1
          AND t.id = ANY($2::uuid[])
      `,
      params: [[IDS.taskQueued, IDS.taskRunning, IDS.taskCompleted]],
      min: 3,
    },
    {
      name: "memory entries",
      sql: `SELECT count(*)::int AS count FROM memory_entry WHERE workspace_id = $1`,
      min: 2,
    },
    {
      name: "memory candidates",
      sql: `SELECT count(*)::int AS count FROM memory_entry WHERE workspace_id = $1 AND status = 'candidate'`,
      min: 1,
    },
    {
      name: "knowledge documents",
      sql: `SELECT count(*)::int AS count FROM knowledge_document WHERE workspace_id = $1 AND status = 'ready'`,
      min: 1,
    },
  ];

  const rows = [];
  for (const check of checks) {
    const params = [workspace.id, ...(check.params || [])];
    const result = await queryOne(client, check.sql, params);
    const count = Number(result.count);
    const ok = count >= check.min;
    rows.push({ name: check.name, count, min: check.min, ok });
    if (!ok) {
      throw new Error(`Smoke check failed for ${check.name}: expected >= ${check.min}, got ${count}.`);
    }
  }

  return { workspace, rows };
}

async function withClient(fn) {
  const { envFile, databaseUrl } = loadRuntimeEnv();
  assertLocalDatabase(databaseUrl);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    return await fn(client, { envFile, databaseUrl });
  } finally {
    await client.end();
  }
}

function printSmokeResult(result) {
  console.log(`AI-ME demo smoke passed for workspace: ${result.workspace.slug}`);
  for (const row of result.rows) {
    console.log(`- ${row.name}: ${row.count} (min ${row.min})`);
  }
}

async function main() {
  const command = process.argv[2] || "seed";

  if (!["seed", "smoke", "seed-and-smoke"].includes(command)) {
    console.error("Usage: node scripts/aime-demo.mjs <seed|smoke|seed-and-smoke>");
    process.exitCode = 1;
    return;
  }

  try {
    await withClient(async (client, env) => {
      console.log(`Using env file: ${env.envFile}`);
      if (command === "seed" || command === "seed-and-smoke") {
        const result = await seed(client);
        console.log(`Seeded AI-ME demo workspace: ${result.workspace.slug}`);
        console.log(`Owner user: ${result.owner.email}`);
        console.log(`Demo pages: /${result.workspace.slug}/dashboard, /${result.workspace.slug}/approvals, /${result.workspace.slug}/inbox, /${result.workspace.slug}/memory`);
      }
      if (command === "smoke" || command === "seed-and-smoke") {
        const result = await smoke(client);
        printSmokeResult(result);
      }
    });
  } catch (error) {
    if (error?.code === "ECONNREFUSED") {
      console.error("Could not connect to PostgreSQL. Start the local database and run migrations first.");
    } else if (error?.code === "42P01") {
      console.error("A required table is missing. Run database migrations before seeding AI-ME demo data.");
    } else {
      console.error(error.message || error);
    }
    process.exitCode = 1;
  }
}

await main();
