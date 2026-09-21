import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ToolInvocation } from "./api";

type ToolStepTimelineProps = {
  invocations: ToolInvocation[];
};

/** 按模型步骤恢复工具调用的并行关系，避免把并发调用误画成串行列表。 */
export function ToolStepTimeline({ invocations }: ToolStepTimelineProps) {
  return groupByStep(invocations).map(([stepIndex, stepInvocations]) => (
    <ToolStepGroup
      key={stepIndex}
      stepIndex={stepIndex}
      invocations={stepInvocations}
    />
  ));
}

function ToolStepGroup({
  stepIndex,
  invocations,
}: {
  stepIndex: number;
  invocations: ToolInvocation[];
}) {
  const allCompleted = invocations.every((invocation) => invocation.status === "completed");
  const hasProblem = invocations.some((invocation) =>
    ["failed", "rejected", "uncertain"].includes(invocation.status),
  );
  const [expanded, setExpanded] = useState(!allCompleted || hasProblem);
  const wasCompleted = useRef(allCompleted);
  const summary = toolStepSummary(invocations);
  const duration = toolStepDuration(invocations);

  useEffect(() => {
    // 运行中的步骤保持展开；刚刚全部成功后自动收起，但不干扰之后的手动展开。
    if (allCompleted && !wasCompleted.current) setExpanded(false);
    if (!allCompleted) setExpanded(true);
    wasCompleted.current = allCompleted;
  }, [allCompleted]);

  return (
    <section className={`tool-step ${hasProblem ? "has-problem" : ""}`} aria-label={`模型步骤 ${stepIndex}`}>
      <button
        type="button"
        className="tool-step-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronRight className="tool-step-chevron" size={14} aria-hidden="true" />
        <strong>模型步骤 {stepIndex}</strong>
        <span>{summary}</span>
        {duration ? <small>{duration}</small> : null}
      </button>
      {expanded ? (
        <div className="tool-step-items">
          {invocations.map((invocation) => (
            <ToolActivityCard key={invocation.id} invocation={invocation} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

const toolStatusLabels: Record<ToolInvocation["status"], string> = {
  prepared: "已准备",
  waiting_for_approval: "等待确认",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  rejected: "已拒绝",
  uncertain: "结果不确定",
};

function ToolActivityCard({ invocation }: { invocation: ToolInvocation }) {
  // Skill 结果复用已有工具卡片，正文不重复铺满会话。
  const skillResult = invocation.toolName === "skill_read" ? invocation.result : null;
  const skillName = typeof skillResult?.name === "string" ? skillResult.name : null;
  const skillVersion = typeof skillResult?.version === "string" ? skillResult.version : null;
  const argumentHint =
    typeof invocation.arguments.path === "string"
      ? invocation.arguments.path
      : typeof invocation.arguments.command === "string"
        ? invocation.arguments.command
        : JSON.stringify(invocation.arguments);
  return (
    <div className={`tool-activity ${invocation.isError ? "failed" : ""}`}>
      <span className="tool-activity-dot" />
      <div>
        <strong>{skillName ? `读取 Skill · ${skillName}` : invocation.toolName}</strong>
        <small>{argumentHint}</small>
        {skillVersion ? <small title={skillVersion}>版本 {skillVersion.slice(0, 12)} · {skillResult?.complete ? "已到末页" : "需继续分页读取"}</small> : null}
        {invocation.isError && typeof invocation.result?.error === "string" ? <small>{invocation.result.error}</small> : null}
      </div>
      <span>{toolStatusLabels[invocation.status]}</span>
    </div>
  );
}

function groupByStep(invocations: ToolInvocation[]) {
  const grouped = new Map<number, ToolInvocation[]>();
  for (const invocation of invocations) {
    const step = grouped.get(invocation.stepIndex) ?? [];
    step.push(invocation);
    grouped.set(invocation.stepIndex, step);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([stepIndex, step]) => [
      stepIndex,
      [...step].sort((left, right) => left.callIndex - right.callIndex),
    ] as const);
}

function toolStepSummary(invocations: ToolInvocation[]) {
  const count = invocations.length;
  if (invocations.some((invocation) => invocation.status === "uncertain")) {
    return `${count} 个工具结果不确定`;
  }
  if (invocations.some((invocation) => invocation.status === "failed")) {
    return `${count} 个工具执行失败`;
  }
  if (invocations.some((invocation) => invocation.status === "rejected")) {
    return `${count} 个工具包含已拒绝调用`;
  }
  if (invocations.some((invocation) => invocation.status === "waiting_for_approval")) {
    return `${count} 个工具等待确认`;
  }
  if (invocations.some((invocation) => ["prepared", "running"].includes(invocation.status))) {
    return `${count} 个工具执行中`;
  }
  const isParallel =
    count > 1 &&
    invocations.every((invocation) => invocation.executionSemantics === "parallel");
  return isParallel ? `${count} 个工具并行完成` : `${count} 个工具已完成`;
}

function toolStepDuration(invocations: ToolInvocation[]) {
  if (invocations.some((invocation) => invocation.finishedAt === null)) return null;
  const startedAt = invocations
    .map((invocation) => Date.parse(invocation.startedAt ?? invocation.preparedAt))
    .filter(Number.isFinite);
  const finishedAt = invocations
    .map((invocation) => Date.parse(invocation.finishedAt ?? ""))
    .filter(Number.isFinite);
  if (startedAt.length === 0 || finishedAt.length === 0) return null;
  const durationMs = Math.max(...finishedAt) - Math.min(...startedAt);
  if (durationMs < 0) return null;
  if (durationMs < 1_000) return `${Math.round(durationMs)} 毫秒`;
  return `${(durationMs / 1_000).toFixed(2)} 秒`;
}
