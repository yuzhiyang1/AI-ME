import { expect, test } from "@playwright/test";
import { createTestApi, loginAsDefault } from "./helpers";
import type { TestApiClient } from "./fixtures";

test.describe("AI-Me orchestration", () => {
  test.setTimeout(180_000);

  let api: TestApiClient;
  let workspaceSlug: string;

  test.beforeEach(async ({ page }) => {
    api = await createTestApi();
    workspaceSlug = await loginAsDefault(page, api);
  });

  test.afterEach(async () => {
    if (api) {
      await api.cleanup();
    }
  });

  test("approves an assignment and shows the worker result on the issue", async ({ page }) => {
    const stamp = Date.now();
    const { runtime, agent, issue } = await test.step("seed AI-Me assignment data", async () => {
      const runtime = await api.registerRuntime({
        daemonId: `aime-ui-e2e-${stamp}`,
        name: `AI-Me UI E2E Runtime ${stamp}`,
      });
      const agent = await api.createAgent({
        name: `AI-Me UI E2E Worker ${stamp}`,
        runtime_id: runtime.id,
      });
      const issue = await api.createIssue(`AI-Me UI E2E refund escalation ${stamp}`, {
        status: "todo",
        priority: "high",
      });
      return { runtime, agent, issue };
    });

    const approvalTitle = `AI-Me UI E2E 分配员工 ${stamp}`;
    const approval = await test.step("create assignment approval", async () => api.createAIApproval({
      source_type: "ai_me_think",
      source_ref_id: issue.id,
      issue_id: issue.id,
      title: approvalTitle,
      summary: "AI-Me 判断该退款升级需要员工核查订单和支付回调。",
      risk_level: "medium",
      confidence: 0.91,
      reversibility: "reversible",
      action_type: "assign_worker",
      action_title: "分配员工处理退款升级",
      action_description: "让员工核查退款链路并在工作项中同步结论。",
      original_payload: {
        issue_id: issue.id,
        target_agent_id: agent.id,
        target_agent_name: agent.name,
        priority: "high",
        instruction: "核查退款链路并同步用户可读结论。",
      },
      ai_reasoning_summary: "订单状态和支付回调不一致，需要员工查看日志后给出结论。",
      evidence: [
        {
          evidence_type: "issue",
          label: "退款升级工作项",
          ref_id: issue.id,
          quote: "用户反馈退款一直显示处理中。",
        },
        {
          evidence_type: "log",
          label: "支付服务日志",
          quote: "refund status remained pending after callback retry",
        },
      ],
    }));

    await test.step("approve assignment in approval center", async () => {
      await page.goto(`/${workspaceSlug}/approvals?approval=${approval.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "审批中心" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("heading", { name: approvalTitle })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("支付服务日志")).toBeVisible({ timeout: 15_000 });

      await page.getByRole("button", { name: /批准并分配员工/ }).click();
      await expect(page.getByText("审批已通过")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("已成功").first()).toBeVisible({ timeout: 10_000 });
    });

    await expect
      .poll(async () => (await api.getAIApproval(approval.id)).created_task_id, {
        timeout: 10_000,
      })
      .not.toBeNull();
    const approved = await api.getAIApproval(approval.id);
    expect(approved.created_task_id).toBeTruthy();

    const task = await api.claimTaskByRuntime(runtime.id);
    expect(task.id).toBe(approved.created_task_id);
    expect(task.agent_id).toBe(agent.id);
    expect(task.issue_id).toBe(issue.id);

    const started = await api.startTask(task.id);
    expect(started.status).toBe("running");

    await api.reportTaskMessages(task.id, [
      {
        seq: 1,
        type: "text",
        content: "正在核查退款订单和支付回调日志。",
      },
      {
        seq: 2,
        type: "tool",
        tool: "grep",
        input: { query: "refund status" },
        output: "found pending refund callback",
      },
    ]);

    const workerOutput = `AI-Me UI E2E 员工结论 ${stamp}：退款仍在队列中，建议先回复用户已收到并持续跟进。`;
    const completed = await api.completeTask(task.id, workerOutput);
    expect(completed.status).toBe("completed");

    await test.step("verify issue detail shows AI-Me trace and worker comment", async () => {
      await page.goto(`/${workspaceSlug}/issues/${issue.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText(issue.title).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText("AI-Me trace")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText("Worker runs")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(agent.name).first()).toBeVisible();
      await expect(page.getByText("Completed").first()).toBeVisible();
      await expect(page.getByText(workerOutput)).toBeVisible({ timeout: 10_000 });
    });
  });
});
