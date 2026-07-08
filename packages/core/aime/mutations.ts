import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import type { AIMeThinkRequest } from "../types";
import { invalidateAIMeWorkSurface } from "./invalidation";

export function useThinkAIMe() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (input: AIMeThinkRequest) => api.thinkAIMe(input),
    onSuccess: () => {
      invalidateAIMeWorkSurface(qc, wsId);
    },
  });
}
