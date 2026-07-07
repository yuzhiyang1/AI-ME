import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { ListAIApprovalsParams } from "../types";

export const approvalKeys = {
  all: (wsId: string) => ["workspaces", wsId, "approvals"] as const,
  stats: (wsId: string) =>
    [...approvalKeys.all(wsId), "stats"] as const,
  list: (wsId: string, params?: ListAIApprovalsParams) =>
    [...approvalKeys.all(wsId), "list", params ?? {}] as const,
  detail: (wsId: string, id: string) =>
    [...approvalKeys.all(wsId), "detail", id] as const,
};

export function approvalListOptions(
  wsId: string,
  params?: ListAIApprovalsParams,
) {
  return queryOptions({
    queryKey: approvalKeys.list(wsId, params),
    queryFn: () => api.listAIApprovals(params),
    staleTime: 30 * 1000,
  });
}

export function approvalStatsOptions(wsId: string) {
  return queryOptions({
    queryKey: approvalKeys.stats(wsId),
    queryFn: () => api.getAIApprovalStats(),
    staleTime: 30 * 1000,
  });
}

export function approvalDetailOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: approvalKeys.detail(wsId, id),
    queryFn: () => api.getAIApproval(id),
    staleTime: 30 * 1000,
  });
}
