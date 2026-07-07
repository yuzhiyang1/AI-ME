import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { ListKnowledgeDocumentsParams, ListMemoryEntriesParams } from "../types";

export const memoryKeys = {
  all: (wsId: string) => ["workspaces", wsId, "memory"] as const,
  list: (wsId: string, params?: ListMemoryEntriesParams) =>
    [...memoryKeys.all(wsId), "list", params ?? {}] as const,
  detail: (wsId: string, id: string) =>
    [...memoryKeys.all(wsId), "detail", id] as const,
  documents: (wsId: string, params?: ListKnowledgeDocumentsParams) =>
    [...memoryKeys.all(wsId), "documents", params ?? {}] as const,
};

export function memoryListOptions(
  wsId: string,
  params?: ListMemoryEntriesParams,
) {
  return queryOptions({
    queryKey: memoryKeys.list(wsId, params),
    queryFn: () => api.listMemoryEntries(params),
    staleTime: 30 * 1000,
  });
}

export function memoryDetailOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: memoryKeys.detail(wsId, id),
    queryFn: () => api.getMemoryEntry(id),
    staleTime: 30 * 1000,
  });
}

export function knowledgeDocumentListOptions(
  wsId: string,
  params?: ListKnowledgeDocumentsParams,
) {
  return queryOptions({
    queryKey: memoryKeys.documents(wsId, params),
    queryFn: () => api.listKnowledgeDocuments(params),
    staleTime: 30 * 1000,
  });
}
