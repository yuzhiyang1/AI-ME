import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const aimeKeys = {
  all: (wsId: string) => ["workspaces", wsId, "aime"] as const,
  cockpitSummary: (wsId: string) =>
    [...aimeKeys.all(wsId), "cockpit-summary"] as const,
};

export function aimeCockpitSummaryOptions(wsId: string) {
  return queryOptions({
    queryKey: aimeKeys.cockpitSummary(wsId),
    queryFn: () => api.getAIMeCockpitSummary(),
    staleTime: 30 * 1000,
  });
}
