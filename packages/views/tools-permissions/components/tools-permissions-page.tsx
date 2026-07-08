"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Database,
  GitPullRequest,
  KeyRound,
  MessageSquare,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { approvalStatsOptions } from "@multica/core/approvals";
import { useWorkspaceId } from "@multica/core/hooks";
import { feishuIntegrationStatusOptions } from "@multica/core/integrations";
import { runtimeListOptions } from "@multica/core/runtimes";
import {
  agentListOptions,
  skillListOptions,
} from "@multica/core/workspace/queries";
import {
  buildToolPermissionRows,
  type ToolPermissionApprovalBehavior,
  type ToolPermissionAvailability,
  type ToolPermissionCategory,
  type ToolPermissionRow,
} from "@multica/core/tools-permissions";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { PageHeader } from "../../layout/page-header";
import { useT } from "../../i18n";

type CategoryFilter = "all" | ToolPermissionCategory;

const CATEGORY_FILTERS: CategoryFilter[] = [
  "all",
  "communication",
  "development",
  "data",
  "publishing",
  "system",
];

const CATEGORY_ICONS: Record<ToolPermissionCategory, typeof MessageSquare> = {
  communication: MessageSquare,
  development: GitPullRequest,
  data: Database,
  publishing: Rocket,
  system: Settings,
};

export function ToolsPermissionsPage() {
  const { t } = useT("tools");
  const wsId = useWorkspaceId();
  const agentsQuery = useQuery(agentListOptions(wsId));
  const runtimesQuery = useQuery(runtimeListOptions(wsId));
  const skillsQuery = useQuery(skillListOptions(wsId));
  const approvalStatsQuery = useQuery(approvalStatsOptions(wsId));
  const feishuStatusQuery = useQuery(feishuIntegrationStatusOptions(wsId));
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const policyRows = useMemo(
    () =>
      buildToolPermissionRows({
        agents: agentsQuery.data ?? [],
        runtimes: runtimesQuery.data ?? [],
        skills: skillsQuery.data ?? [],
        approvalStats: approvalStatsQuery.data ?? null,
        feishuStatus: feishuStatusQuery.data ?? null,
      }),
    [
      agentsQuery.data,
      approvalStatsQuery.data,
      feishuStatusQuery.data,
      runtimesQuery.data,
      skillsQuery.data,
    ],
  );
  const rows = useMemo(() => policyRows.map((row) => localizePolicyRow(row, t)), [policyRows, t]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (category !== "all" && row.category !== category) return false;
      if (!q) return true;
      return `${row.name} ${row.description} ${row.source} ${row.callers}`
        .toLowerCase()
        .includes(q);
    });
  }, [category, rows, search]);

  const selected = filteredRows.find((row) => row.id === selectedId) ?? filteredRows[0] ?? null;
  const loading =
    agentsQuery.isLoading ||
    runtimesQuery.isLoading ||
    skillsQuery.isLoading ||
    feishuStatusQuery.isLoading;
  const error =
    agentsQuery.error ??
    runtimesQuery.error ??
    skillsQuery.error;
  const metrics = useMemo(() => summarizeRows(rows), [rows]);

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ToolsHeader />
        <div className="space-y-4 p-6">
          <div className="grid gap-3 md:grid-cols-4">
            {[0, 1, 2, 3].map((item) => (
              <Skeleton key={item} className="h-20 rounded-lg" />
            ))}
          </div>
          <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Skeleton className="h-[520px] rounded-lg" />
            <Skeleton className="h-[520px] rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ToolsHeader />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <div>
            <p className="text-sm font-medium">{t(($) => $.error.title)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {error instanceof Error ? error.message : t(($) => $.error.description)}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              agentsQuery.refetch();
              runtimesQuery.refetch();
              skillsQuery.refetch();
              approvalStatsQuery.refetch();
              feishuStatusQuery.refetch();
            }}
          >
            {t(($) => $.error.retry)}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/20">
      <ToolsHeader />
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        <div className="grid gap-3 md:grid-cols-4">
          <MetricCard label={t(($) => $.metrics.enabled)} value={String(metrics.enabled)} />
          <MetricCard label={t(($) => $.metrics.approval)} value={String(metrics.approval)} tone="warning" />
          <MetricCard label={t(($) => $.metrics.blocked)} value={String(metrics.blocked)} tone="danger" />
          <MetricCard label={t(($) => $.metrics.connected)} value={String(metrics.connected)} tone="info" />
        </div>

        <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-background">
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
              <div className="relative min-w-64 flex-1 md:flex-none">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t(($) => $.search_placeholder)}
                  className="h-8 pl-8 text-sm"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CATEGORY_FILTERS.map((filter) => (
                  <Button
                    key={filter}
                    type="button"
                    size="sm"
                    variant="outline"
                    className={cn(
                      "h-8",
                      category === filter && "border-brand/40 bg-brand/10 text-brand",
                    )}
                    onClick={() => setCategory(filter)}
                  >
                    {categoryLabel(filter, t)}
                  </Button>
                ))}
              </div>
            </div>
            {filteredRows.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <Search className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm">{t(($) => $.empty_search.title)}</p>
                <p className="max-w-sm text-xs">{t(($) => $.empty_search.description)}</p>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="divide-y">
                  {filteredRows.map((row) => (
                    <ToolPolicyRow
                      key={row.id}
                      row={row}
                      selected={selected?.id === row.id}
                      onSelect={() => setSelectedId(row.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>

          <ToolDetailPanel row={selected} />
        </div>
      </div>
    </div>
  );
}

function ToolsHeader() {
  const { t } = useT("tools");
  return (
    <PageHeader className="h-14 justify-between px-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-brand" />
          <h1 className="text-sm font-semibold">{t(($) => $.page.title)}</h1>
        </div>
        <p className="mt-0.5 hidden text-xs text-muted-foreground md:block">
          {t(($) => $.page.subtitle)}
        </p>
      </div>
      <div className="hidden items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground md:flex">
        <KeyRound className="h-3.5 w-3.5" />
        {t(($) => $.page.policy_hint)}
      </div>
    </PageHeader>
  );
}

function MetricCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warning" | "danger" | "info";
}) {
  return (
    <div className="rounded-lg border bg-background p-4 shadow-xs">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-2 font-mono text-2xl font-semibold tabular-nums",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-destructive",
          tone === "info" && "text-info",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function ToolPolicyRow({
  row,
  selected,
  onSelect,
}: {
  row: ToolPermissionRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = CATEGORY_ICONS[row.category];
  return (
    <button
      type="button"
      className={cn(
        "grid w-full grid-cols-[minmax(220px,1.4fr)_160px_160px_120px] items-center gap-4 px-4 py-3 text-left text-sm transition-colors hover:bg-muted/50",
        selected && "bg-brand/5",
      )}
      onClick={onSelect}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{row.name}</div>
          <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {row.description}
          </div>
        </div>
      </div>
      <StatusPill availability={row.availability} />
      <ApprovalPill behavior={row.approvalBehavior} />
      <div className="truncate text-xs text-muted-foreground">{row.source}</div>
    </button>
  );
}

function ToolDetailPanel({ row }: { row: ToolPermissionRow | null }) {
  const { t } = useT("tools");
  if (!row) {
    return (
      <aside className="rounded-lg border bg-background p-5 text-sm text-muted-foreground">
        {t(($) => $.detail.empty)}
      </aside>
    );
  }
  const Icon = CATEGORY_ICONS[row.category];
  return (
    <aside className="flex min-h-0 flex-col rounded-lg border bg-background">
      <div className="border-b p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{row.name}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{row.description}</p>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <DetailRow label={t(($) => $.detail.category)} value={categoryLabel(row.category, t)} />
        <DetailRow label={t(($) => $.detail.scope)} value={row.scope} />
        <DetailRow label={t(($) => $.detail.callers)} value={row.callers} />
        <DetailRow label={t(($) => $.detail.approval)} value={approvalBehaviorLabel(row.approvalBehavior, t)} />
        <DetailRow label={t(($) => $.detail.source)} value={row.source} />
        <DetailRow label={t(($) => $.detail.last_used)} value={row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : t(($) => $.detail.never)} />
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="text-xs font-medium text-foreground">{t(($) => $.detail.audit)}</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{row.auditHint}</p>
        </div>
      </div>
    </aside>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-3 text-xs">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0 text-foreground">{value}</div>
    </div>
  );
}

function StatusPill({ availability }: { availability: ToolPermissionAvailability }) {
  const { t } = useT("tools");
  const Icon =
    availability === "enabled" || availability === "available"
      ? CheckCircle2
      : availability === "disabled"
        ? Ban
        : AlertCircle;
  return (
    <span className={cn("inline-flex w-fit items-center gap-1 rounded-full px-2 py-1 text-xs", availabilityClass(availability))}>
      <Icon className="h-3 w-3" />
      {availabilityLabel(availability, t)}
    </span>
  );
}

function ApprovalPill({ behavior }: { behavior: ToolPermissionApprovalBehavior }) {
  const { t } = useT("tools");
  return (
    <span className={cn("inline-flex w-fit items-center gap-1 rounded-full px-2 py-1 text-xs", approvalBehaviorClass(behavior))}>
      <ShieldCheck className="h-3 w-3" />
      {approvalBehaviorLabel(behavior, t)}
    </span>
  );
}

function summarizeRows(rows: ToolPermissionRow[]) {
  return {
    enabled: rows.filter((row) => row.availability === "enabled").length,
    approval: rows.filter(
      (row) =>
        row.approvalBehavior === "requires_approval" ||
        row.approvalBehavior === "always_requires_approval",
    ).length,
    blocked: rows.filter((row) => row.approvalBehavior === "blocked").length,
    connected: rows.filter((row) => row.primaryCount > 0).length,
  };
}

type ToolsT = ReturnType<typeof useT<"tools">>["t"];

function localizePolicyRow(row: ToolPermissionRow, t: ToolsT): ToolPermissionRow {
  switch (row.id) {
    case "workspace-read":
      return {
        ...row,
        name: t(($) => $.policies.workspace_read.name),
        description: t(($) => $.policies.workspace_read.description),
        scope: t(($) => $.policies.workspace_read.scope),
        callers: t(($) => $.policies.workspace_read.callers),
        source: t(($) => $.policies.workspace_read.source),
        auditHint: t(($) => $.policies.workspace_read.audit),
      };
    case "assign-worker":
      return {
        ...row,
        name: t(($) => $.policies.assign_worker.name),
        description: t(($) => $.policies.assign_worker.description),
        scope: t(($) => $.policies.assign_worker.scope),
        callers: t(($) => $.policies.assign_worker.callers),
        source: t(($) => $.policies.assign_worker.source, { count: row.primaryCount }),
        auditHint:
          row.secondaryCount > 0
            ? t(($) => $.policies.assign_worker.audit_pending, { count: row.secondaryCount })
            : t(($) => $.policies.assign_worker.audit),
      };
    case "runtime-execution":
      return {
        ...row,
        name: t(($) => $.policies.runtime_execution.name),
        description: t(($) => $.policies.runtime_execution.description),
        scope: t(($) => $.policies.runtime_execution.scope),
        source: t(($) => $.policies.runtime_execution.source, {
          online: row.secondaryCount,
          total: row.primaryCount,
        }),
        auditHint: t(($) => $.policies.runtime_execution.audit),
      };
    case "post-internal-comment":
      return {
        ...row,
        name: t(($) => $.policies.post_internal_comment.name),
        description: t(($) => $.policies.post_internal_comment.description),
        scope: t(($) => $.policies.post_internal_comment.scope),
        callers: t(($) => $.policies.post_internal_comment.callers),
        source: t(($) => $.policies.post_internal_comment.source),
        auditHint: t(($) => $.policies.post_internal_comment.audit),
      };
    case "feishu-messages":
      return {
        ...row,
        name: t(($) => $.policies.feishu_messages.name),
        description: t(($) => $.policies.feishu_messages.description),
        scope:
          row.scope === "Allowed Feishu chat"
            ? t(($) => $.policies.feishu_messages.scope_allowed_chat)
            : t(($) => $.policies.feishu_messages.scope_workspace),
        callers: t(($) => $.policies.feishu_messages.callers),
        source:
          row.source === "Not connected"
            ? t(($) => $.policies.feishu_messages.source_not_connected)
            : t(($) => $.policies.feishu_messages.source, { mode: row.source }),
        auditHint:
          row.secondaryCount > 0
            ? t(($) => $.policies.feishu_messages.audit_warning, { warning: row.auditHint })
            : t(($) => $.policies.feishu_messages.audit),
      };
    case "external-message":
      return {
        ...row,
        name: t(($) => $.policies.external_message.name),
        description: t(($) => $.policies.external_message.description),
        scope: t(($) => $.policies.external_message.scope),
        callers: t(($) => $.policies.external_message.callers),
        source: t(($) => $.policies.external_message.source),
        auditHint: t(($) => $.policies.external_message.audit),
      };
    case "skills-context":
      return {
        ...row,
        name: t(($) => $.policies.skills_context.name),
        description: t(($) => $.policies.skills_context.description),
        scope: t(($) => $.policies.skills_context.scope),
        callers: t(($) => $.policies.skills_context.callers),
        source: t(($) => $.policies.skills_context.source, { count: row.primaryCount }),
        auditHint: t(($) => $.policies.skills_context.audit),
      };
    case "memory-external-use":
      return {
        ...row,
        name: t(($) => $.policies.memory_external_use.name),
        description: t(($) => $.policies.memory_external_use.description),
        scope: t(($) => $.policies.memory_external_use.scope),
        callers: t(($) => $.policies.memory_external_use.callers),
        source: t(($) => $.policies.memory_external_use.source),
        auditHint: t(($) => $.policies.memory_external_use.audit),
      };
    case "merge-pull-request":
      return {
        ...row,
        name: t(($) => $.policies.merge_pull_request.name),
        description: t(($) => $.policies.merge_pull_request.description),
        scope: t(($) => $.policies.merge_pull_request.scope),
        callers: t(($) => $.policies.merge_pull_request.callers),
        source: t(($) => $.policies.merge_pull_request.source),
        auditHint: t(($) => $.policies.merge_pull_request.audit),
      };
    case "production-deploy":
      return {
        ...row,
        name: t(($) => $.policies.production_deploy.name),
        description: t(($) => $.policies.production_deploy.description),
        scope: t(($) => $.policies.production_deploy.scope),
        callers: t(($) => $.policies.production_deploy.callers),
        source: t(($) => $.policies.production_deploy.source),
        auditHint: t(($) => $.policies.production_deploy.audit),
      };
    default:
      return row;
  }
}

function categoryLabel(category: CategoryFilter, t: ToolsT) {
  switch (category) {
    case "all":
      return t(($) => $.categories.all);
    case "communication":
      return t(($) => $.categories.communication);
    case "development":
      return t(($) => $.categories.development);
    case "data":
      return t(($) => $.categories.data);
    case "publishing":
      return t(($) => $.categories.publishing);
    case "system":
      return t(($) => $.categories.system);
    default:
      return category;
  }
}

function availabilityLabel(availability: ToolPermissionAvailability, t: ToolsT) {
  switch (availability) {
    case "enabled":
      return t(($) => $.availability.enabled);
    case "available":
      return t(($) => $.availability.available);
    case "not_configured":
      return t(($) => $.availability.not_configured);
    case "disabled":
      return t(($) => $.availability.disabled);
    default:
      return availability;
  }
}

function approvalBehaviorLabel(behavior: ToolPermissionApprovalBehavior, t: ToolsT) {
  switch (behavior) {
    case "auto":
      return t(($) => $.approval.auto);
    case "requires_approval":
      return t(($) => $.approval.requires_approval);
    case "always_requires_approval":
      return t(($) => $.approval.always_requires_approval);
    case "blocked":
      return t(($) => $.approval.blocked);
    default:
      return behavior;
  }
}

function availabilityClass(availability: ToolPermissionAvailability) {
  switch (availability) {
    case "enabled":
      return "bg-success/10 text-success";
    case "available":
      return "bg-info/10 text-info";
    case "not_configured":
      return "bg-warning/10 text-warning";
    case "disabled":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function approvalBehaviorClass(behavior: ToolPermissionApprovalBehavior) {
  switch (behavior) {
    case "auto":
      return "bg-success/10 text-success";
    case "requires_approval":
      return "bg-warning/10 text-warning";
    case "always_requires_approval":
      return "bg-warning/10 text-warning";
    case "blocked":
      return "bg-destructive/10 text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
}
