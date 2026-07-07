import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import type { AIMeThinkRequest } from "../types";

export function useThinkAIMe() {
  return useMutation({
    mutationFn: (input: AIMeThinkRequest) => api.thinkAIMe(input),
  });
}
