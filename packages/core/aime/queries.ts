import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { ListAIMeDecisionsParams } from "../types";

export const aimeKeys = {
  all: (wsId: string) => ["workspaces", wsId, "aime"] as const,
  cockpitSummary: (wsId: string) =>
    [...aimeKeys.all(wsId), "cockpit-summary"] as const,
  decisions: (wsId: string, params?: ListAIMeDecisionsParams) =>
    [...aimeKeys.all(wsId), "decisions", params ?? {}] as const,
  onboarding: (wsId: string) =>
    [...aimeKeys.all(wsId), "onboarding"] as const,
  feishuDogfood: (wsId: string, params?: { limit?: number; offset?: number }) =>
    [...aimeKeys.all(wsId), "feishu-dogfood", params ?? {}] as const,
};

export function aimeCockpitSummaryOptions(wsId: string) {
  return queryOptions({
    queryKey: aimeKeys.cockpitSummary(wsId),
    queryFn: () => api.getAIMeCockpitSummary(),
    staleTime: 30 * 1000,
  });
}

export function aimeDecisionLedgerOptions(
  wsId: string,
  params?: ListAIMeDecisionsParams,
) {
  return queryOptions({
    queryKey: aimeKeys.decisions(wsId, params),
    queryFn: () => api.listAIMeDecisions(params),
    staleTime: 30 * 1000,
  });
}

export function aimeOnboardingStatusOptions(wsId: string) {
  return queryOptions({
    queryKey: aimeKeys.onboarding(wsId),
    queryFn: () => api.getAIMeOnboardingStatus(),
    staleTime: 30 * 1000,
  });
}

export function feishuDogfoodPanelOptions(
  wsId: string,
  params?: { limit?: number; offset?: number },
) {
  return queryOptions({
    queryKey: aimeKeys.feishuDogfood(wsId, params),
    queryFn: () => api.getFeishuDogfoodPanel(params),
    staleTime: 15 * 1000,
  });
}
