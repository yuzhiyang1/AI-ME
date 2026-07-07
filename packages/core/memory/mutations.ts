import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import type {
  CreateKnowledgeDocumentRequest,
  CreateMemoryEntryRequest,
  ListMemoryEntriesResponse,
  MemoryEntry,
  UpdateMemoryEntryRequest,
} from "../types";
import { memoryKeys } from "./queries";

function invalidateMemoryLists(
  qc: ReturnType<typeof useQueryClient>,
  wsId: string,
) {
  qc.invalidateQueries({ queryKey: memoryKeys.all(wsId) });
}

export function useCreateMemoryEntry() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: CreateMemoryEntryRequest) => api.createMemoryEntry(data),
    onSuccess: (memory) => {
      qc.setQueryData<MemoryEntry>(memoryKeys.detail(wsId, memory.id), memory);
      qc.setQueriesData<ListMemoryEntriesResponse>(
        { queryKey: memoryKeys.all(wsId) },
        (old) => old && "memories" in old
          ? {
              ...old,
              memories: old.memories.some((item) => item.id === memory.id)
                ? old.memories.map((item) => (item.id === memory.id ? memory : item))
                : [memory, ...old.memories],
              total: old.memories.some((item) => item.id === memory.id)
                ? old.total
                : old.total + 1,
            }
          : old,
      );
    },
    onSettled: () => invalidateMemoryLists(qc, wsId),
  });
}

export function useUpdateMemoryEntry() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateMemoryEntryRequest) =>
      api.updateMemoryEntry(id, data),
    onSuccess: (memory) => {
      qc.setQueryData<MemoryEntry>(memoryKeys.detail(wsId, memory.id), memory);
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: memoryKeys.detail(wsId, vars.id) });
      invalidateMemoryLists(qc, wsId);
    },
  });
}

function useMemoryTransition(
  transition: (id: string) => Promise<MemoryEntry>,
) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: transition,
    onSuccess: (memory) => {
      qc.setQueryData<MemoryEntry>(memoryKeys.detail(wsId, memory.id), memory);
    },
    onSettled: (_data, _err, id) => {
      qc.invalidateQueries({ queryKey: memoryKeys.detail(wsId, id) });
      invalidateMemoryLists(qc, wsId);
    },
  });
}

export function useConfirmMemoryEntry() {
  return useMemoryTransition((id) => api.confirmMemoryEntry(id));
}

export function useRejectMemoryEntry() {
  return useMemoryTransition((id) => api.rejectMemoryEntry(id));
}

export function useArchiveMemoryEntry() {
  return useMemoryTransition((id) => api.archiveMemoryEntry(id));
}

export function useVerifyMemoryEntry() {
  return useMemoryTransition((id) => api.verifyMemoryEntry(id));
}

export function useCreateKnowledgeDocument() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: CreateKnowledgeDocumentRequest) =>
      api.createKnowledgeDocument(data),
    onSettled: () => invalidateMemoryLists(qc, wsId),
  });
}
