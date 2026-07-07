import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import type {
  AIApproval,
  AIApprovalTransitionRequest,
  CreateAIApprovalRequest,
  ListAIApprovalsResponse,
  UpdateAIApprovalRequest,
} from "../types";
import { approvalKeys } from "./queries";

function invalidateApprovalLists(
  qc: ReturnType<typeof useQueryClient>,
  wsId: string,
) {
  qc.invalidateQueries({ queryKey: approvalKeys.all(wsId) });
}

function useApprovalTransition(
  transition: (id: string, data?: AIApprovalTransitionRequest) => Promise<AIApproval>,
) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data?: AIApprovalTransitionRequest }) =>
      transition(id, data),
    onSuccess: (approval) => {
      qc.setQueryData<AIApproval>(approvalKeys.detail(wsId, approval.id), approval);
    },
    onSettled: (_data, _error, vars) => {
      qc.invalidateQueries({ queryKey: approvalKeys.detail(wsId, vars.id) });
      invalidateApprovalLists(qc, wsId);
    },
  });
}

export function useCreateAIApproval() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: CreateAIApprovalRequest) => api.createAIApproval(data),
    onSuccess: (approval) => {
      qc.setQueryData<AIApproval>(approvalKeys.detail(wsId, approval.id), approval);
      qc.setQueriesData<ListAIApprovalsResponse>(
        { queryKey: approvalKeys.all(wsId) },
        (old) => old && "approvals" in old
          ? {
              ...old,
              approvals: old.approvals.some((item) => item.id === approval.id)
                ? old.approvals.map((item) => (item.id === approval.id ? approval : item))
                : [approval, ...old.approvals],
              total: old.approvals.some((item) => item.id === approval.id)
                ? old.total
                : old.total + 1,
            }
          : old,
      );
    },
    onSettled: () => invalidateApprovalLists(qc, wsId),
  });
}

export function useUpdateAIApproval() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateAIApprovalRequest) =>
      api.updateAIApproval(id, data),
    onSuccess: (approval) => {
      qc.setQueryData<AIApproval>(approvalKeys.detail(wsId, approval.id), approval);
    },
    onSettled: (_data, _error, vars) => {
      qc.invalidateQueries({ queryKey: approvalKeys.detail(wsId, vars.id) });
      invalidateApprovalLists(qc, wsId);
    },
  });
}

export function useApproveAIApproval() {
  return useApprovalTransition((id, data) => api.approveAIApproval(id, data));
}

export function useRejectAIApproval() {
  return useApprovalTransition((id, data) => api.rejectAIApproval(id, data));
}

export function useObserveAIApproval() {
  return useApprovalTransition((id, data) => api.observeAIApproval(id, data));
}

export function useTakeOverAIApproval() {
  return useApprovalTransition((id, data) => api.takeOverAIApproval(id, data));
}
