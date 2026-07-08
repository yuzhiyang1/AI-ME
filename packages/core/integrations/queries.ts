import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const integrationKeys = {
  all: (wsId: string) => ["workspaces", wsId, "integrations"] as const,
  feishuStatus: (wsId: string) =>
    [...integrationKeys.all(wsId), "feishu", "status"] as const,
};

export function feishuIntegrationStatusOptions(wsId: string) {
  return queryOptions({
    queryKey: integrationKeys.feishuStatus(wsId),
    queryFn: () => api.getFeishuIntegrationStatus(),
    staleTime: 30 * 1000,
  });
}
