"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bell,
  Bot,
  Brain,
  Database,
  type LucideIcon,
  Save,
  ShieldCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import {
  AIME_APPROVAL_MODES,
  AIME_AUTONOMY_LEVELS,
  AIME_DIGEST_CADENCES,
  AIME_MODEL_PROVIDERS,
  getAIMeWorkspaceSettings,
  mergeAIMeWorkspaceSettings,
  type AIMeApprovalMode,
  type AIMeAutonomyLevel,
  type AIMeDigestCadence,
  type AIMeModelProvider,
  type AIMeWorkspaceSettings,
} from "@multica/core/aime";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useCurrentWorkspace } from "@multica/core/paths";
import { api } from "@multica/core/api";
import type { Workspace } from "@multica/core/types";
import {
  agentListOptions,
  memberListOptions,
  workspaceKeys,
} from "@multica/core/workspace/queries";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { Switch } from "@multica/ui/components/ui/switch";
import { useT } from "../../i18n";

export function AIMeSettingsTab() {
  const { t } = useT("settings");
  const workspace = useCurrentWorkspace();
  const wsId = useWorkspaceId();
  const currentUser = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<AIMeWorkspaceSettings>(() =>
    getAIMeWorkspaceSettings(workspace?.settings),
  );

  useEffect(() => {
    setDraft(getAIMeWorkspaceSettings(workspace?.settings));
  }, [workspace?.settings]);

  const currentMember = members.find((m) => m.user_id === currentUser?.id);
  const canManage = currentMember?.role === "owner" || currentMember?.role === "admin";
  const activeAgents = agents.filter((agent) => !agent.archived_at);
  const workingAgents = activeAgents.filter((agent) => agent.status === "working");
  const onlineAgents = activeAgents.filter((agent) => agent.status !== "offline");
  const latestModelFromAgents = useMemo(() => {
    const models = activeAgents
      .map((agent) => agent.model)
      .filter((model): model is string => !!model);
    return models[0] ?? null;
  }, [activeAgents]);
  const savedSettings = useMemo(
    () => getAIMeWorkspaceSettings(workspace?.settings),
    [workspace?.settings],
  );
  const hasChanges = JSON.stringify(draft) !== JSON.stringify(savedSettings);

  const updateDraft = (patch: Partial<AIMeWorkspaceSettings>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const updateWorkingHours = (patch: Partial<AIMeWorkspaceSettings["working_hours"]>) => {
    setDraft((current) => ({
      ...current,
      working_hours: {
        ...current.working_hours,
        ...patch,
      },
    }));
  };

  const handleSave = async () => {
    if (!workspace || saving || !canManage) return;
    setSaving(true);
    try {
      const updated = await api.updateWorkspace(workspace.id, {
        settings: mergeAIMeWorkspaceSettings(workspace.settings, draft),
      });
      qc.setQueryData(workspaceKeys.list(), (old: Workspace[] | undefined) =>
        old?.map((ws) => (ws.id === updated.id ? updated : ws)),
      );
      toast.success(t(($) => $.aime.toast_saved));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t(($) => $.aime.toast_failed),
      );
    } finally {
      setSaving(false);
    }
  };

  if (!workspace) return null;

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">{t(($) => $.aime.title)}</h2>
              <Badge variant={draft.enabled ? "default" : "secondary"}>
                {draft.enabled
                  ? t(($) => $.aime.status.enabled)
                  : t(($) => $.aime.status.disabled)}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(($) => $.aime.description)}
            </p>
          </div>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!canManage || saving || !hasChanges}
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? t(($) => $.aime.saving) : t(($) => $.aime.save)}
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatusTile
            icon={Users}
            label={t(($) => $.aime.metrics.employees)}
            value={`${onlineAgents.length}/${activeAgents.length}`}
            hint={t(($) => $.aime.metrics.employees_hint)}
          />
          <StatusTile
            icon={Activity}
            label={t(($) => $.aime.metrics.working)}
            value={String(workingAgents.length)}
            hint={t(($) => $.aime.metrics.working_hint)}
          />
          <StatusTile
            icon={Brain}
            label={t(($) => $.aime.metrics.model)}
            value={latestModelFromAgents ?? draft.model_name}
            hint={t(($) => $.aime.metrics.model_hint)}
          />
          <StatusTile
            icon={ShieldCheck}
            label={t(($) => $.aime.metrics.approval)}
            value={t(($) => $.aime.approval_modes[draft.approval_mode].label)}
            hint={t(($) => $.aime.metrics.approval_hint)}
          />
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeader
          icon={ShieldCheck}
          title={t(($) => $.aime.sections.work_policy)}
          description={t(($) => $.aime.sections.work_policy_description)}
        />
        <Card>
          <CardContent className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="aime-enabled" className="text-sm font-medium">
                  {t(($) => $.aime.fields.enabled.label)}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.aime.fields.enabled.description)}
                </p>
              </div>
              <Switch
                id="aime-enabled"
                checked={draft.enabled}
                disabled={!canManage}
                onCheckedChange={(enabled) => updateDraft({ enabled })}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <FieldBlock
                label={t(($) => $.aime.fields.autonomy.label)}
                description={t(($) => $.aime.fields.autonomy.description)}
              >
                <Select
                  value={draft.autonomy_level}
                  onValueChange={(value) =>
                    updateDraft({ autonomy_level: value as AIMeAutonomyLevel })
                  }
                  disabled={!canManage}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {() =>
                        t(($) => $.aime.autonomy_levels[draft.autonomy_level].label)
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {AIME_AUTONOMY_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {t(($) => $.aime.autonomy_levels[level].label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldBlock>

              <FieldBlock
                label={t(($) => $.aime.fields.approval.label)}
                description={t(($) => $.aime.fields.approval.description)}
              >
                <Select
                  value={draft.approval_mode}
                  onValueChange={(value) =>
                    updateDraft({ approval_mode: value as AIMeApprovalMode })
                  }
                  disabled={!canManage}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {() =>
                        t(($) => $.aime.approval_modes[draft.approval_mode].label)
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {AIME_APPROVAL_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {t(($) => $.aime.approval_modes[mode].label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldBlock>

              <FieldBlock
                label={t(($) => $.aime.fields.digest.label)}
                description={t(($) => $.aime.fields.digest.description)}
              >
                <Select
                  value={draft.digest_cadence}
                  onValueChange={(value) =>
                    updateDraft({ digest_cadence: value as AIMeDigestCadence })
                  }
                  disabled={!canManage}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {() =>
                        t(($) => $.aime.digest_cadences[draft.digest_cadence].label)
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {AIME_DIGEST_CADENCES.map((cadence) => (
                      <SelectItem key={cadence} value={cadence}>
                        {t(($) => $.aime.digest_cadences[cadence].label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldBlock>

              <FieldBlock
                label={t(($) => $.aime.fields.timezone.label)}
                description={t(($) => $.aime.fields.timezone.description)}
              >
                <Input
                  value={draft.timezone}
                  disabled={!canManage}
                  onChange={(event) =>
                    updateDraft({ timezone: event.target.value })
                  }
                />
              </FieldBlock>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <FieldBlock
                label={t(($) => $.aime.fields.work_start.label)}
                description={t(($) => $.aime.fields.work_start.description)}
              >
                <Input
                  type="time"
                  value={draft.working_hours.start}
                  disabled={!canManage}
                  onChange={(event) =>
                    updateWorkingHours({ start: event.target.value })
                  }
                />
              </FieldBlock>
              <FieldBlock
                label={t(($) => $.aime.fields.work_end.label)}
                description={t(($) => $.aime.fields.work_end.description)}
              >
                <Input
                  type="time"
                  value={draft.working_hours.end}
                  disabled={!canManage}
                  onChange={(event) =>
                    updateWorkingHours({ end: event.target.value })
                  }
                />
              </FieldBlock>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-4">
        <SectionHeader
          icon={Brain}
          title={t(($) => $.aime.sections.model)}
          description={t(($) => $.aime.sections.model_description)}
        />
        <Card>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <FieldBlock
              label={t(($) => $.aime.fields.model_provider.label)}
              description={t(($) => $.aime.fields.model_provider.description)}
            >
              <Select
                value={draft.model_provider}
                onValueChange={(value) =>
                  updateDraft({ model_provider: value as AIMeModelProvider })
                }
                disabled={!canManage}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {() => t(($) => $.aime.model_providers[draft.model_provider])}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {AIME_MODEL_PROVIDERS.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {t(($) => $.aime.model_providers[provider])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldBlock>

            <FieldBlock
              label={t(($) => $.aime.fields.model_name.label)}
              description={t(($) => $.aime.fields.model_name.description)}
            >
              <Input
                value={draft.model_name}
                disabled={!canManage}
                onChange={(event) =>
                  updateDraft({ model_name: event.target.value })
                }
              />
            </FieldBlock>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-4">
        <SectionHeader
          icon={Database}
          title={t(($) => $.aime.sections.data)}
          description={t(($) => $.aime.sections.data_description)}
        />
        <Card>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <FieldBlock
                label={t(($) => $.aime.fields.memory_retention.label)}
                description={t(($) => $.aime.fields.memory_retention.description)}
              >
                <Input
                  type="number"
                  min={1}
                  value={draft.memory_retention_days}
                  disabled={!canManage}
                  onChange={(event) =>
                    updateDraft({
                      memory_retention_days: Math.max(
                        1,
                        Number(event.target.value) || 1,
                      ),
                    })
                  }
                />
              </FieldBlock>
              <FieldBlock
                label={t(($) => $.aime.fields.data_retention.label)}
                description={t(($) => $.aime.fields.data_retention.description)}
              >
                <Input
                  type="number"
                  min={1}
                  value={draft.data_retention_days}
                  disabled={!canManage}
                  onChange={(event) =>
                    updateDraft({
                      data_retention_days: Math.max(
                        1,
                        Number(event.target.value) || 1,
                      ),
                    })
                  }
                />
              </FieldBlock>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <ReadOnlyFact
                icon={Database}
                label={t(($) => $.aime.facts.storage.label)}
                value={t(($) => $.aime.facts.storage.value)}
              />
              <ReadOnlyFact
                icon={Bell}
                label={t(($) => $.aime.facts.notifications.label)}
                value={t(($) => $.aime.facts.notifications.value)}
              />
            </div>

            {!canManage && (
              <p className="text-xs text-muted-foreground">
                {t(($) => $.aime.manage_hint)}
              </p>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function FieldBlock({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label className="text-xs font-medium text-foreground">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

function StatusTile({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card size="sm">
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          <span>{label}</span>
        </div>
        <div className="truncate text-xl font-semibold">{value}</div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function ReadOnlyFact({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
      <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-sm">{value}</p>
      </div>
    </div>
  );
}
