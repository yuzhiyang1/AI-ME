export type MemoryType =
  | "identity"
  | "preference"
  | "rule"
  | "project_fact"
  | "process"
  | "history"
  | "relationship"
  | "technical_context";

export type MemoryStatus = "candidate" | "active" | "rejected" | "archived";

export type MemorySensitivity = "normal" | "private" | "restricted";

export type MemoryScopeType = "user" | "workspace" | "project" | "agent";

export type MemoryExternalUsePolicy = "never" | "with_approval" | "allowed";

export type MemorySourceMode = "manual" | "inferred" | "imported" | "integration";

export type KnowledgeDocumentStatus =
  | "queued"
  | "processing"
  | "ready"
  | "failed"
  | "archived";

export interface MemorySource {
  id: string;
  workspace_id: string;
  source_type: string;
  source_ref_id: string | null;
  source_url: string | null;
  title: string;
  excerpt: string;
  metadata: unknown;
  captured_at: string | null;
  created_at: string;
}

export interface MemoryEvidence {
  id: string;
  memory_id: string;
  source_id: string;
  excerpt: string;
  location: string;
  confidence: number;
  created_at: string;
  source: MemorySource;
}

export interface MemoryUsage {
  id: string;
  workspace_id: string;
  memory_id: string;
  used_by_type: string;
  used_by_id: string | null;
  issue_id: string | null;
  task_queue_id: string | null;
  chat_session_id: string | null;
  action: string;
  outcome: string;
  created_at: string;
}

export interface MemoryEntry {
  id: string;
  workspace_id: string;
  owner_user_id: string | null;
  project_id: string | null;
  type: MemoryType;
  category: string;
  title: string;
  content: string;
  summary: string;
  status: MemoryStatus;
  confidence: number;
  sensitivity: MemorySensitivity;
  scope_type: MemoryScopeType;
  scope_ref_id: string | null;
  external_use_policy: MemoryExternalUsePolicy;
  source_mode: MemorySourceMode;
  created_by_type: string;
  created_by_id: string | null;
  verified_by: string | null;
  verified_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  evidence?: MemoryEvidence[];
  usage?: MemoryUsage[];
}

export interface ListMemoryEntriesParams {
  status?: MemoryStatus;
  type?: MemoryType;
  category?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ListMemoryEntriesResponse {
  memories: MemoryEntry[];
  total: number;
}

export interface CreateMemoryEvidenceRequest {
  source_type: string;
  source_ref_id?: string;
  source_url?: string;
  title?: string;
  excerpt?: string;
  metadata?: unknown;
  captured_at?: string;
  location?: string;
  confidence?: number;
}

export interface CreateMemoryEntryRequest {
  owner_user_id?: string;
  project_id?: string;
  type: MemoryType;
  category?: string;
  title: string;
  content: string;
  summary?: string;
  status?: MemoryStatus;
  confidence?: number;
  sensitivity?: MemorySensitivity;
  scope_type?: MemoryScopeType;
  scope_ref_id?: string;
  external_use_policy?: MemoryExternalUsePolicy;
  source_mode?: MemorySourceMode;
  expires_at?: string;
  evidence?: CreateMemoryEvidenceRequest[];
}

export interface UpdateMemoryEntryRequest {
  owner_user_id?: string | null;
  project_id?: string | null;
  type?: MemoryType;
  category?: string;
  title?: string;
  content?: string;
  summary?: string;
  status?: MemoryStatus;
  confidence?: number;
  sensitivity?: MemorySensitivity;
  scope_type?: MemoryScopeType;
  scope_ref_id?: string | null;
  external_use_policy?: MemoryExternalUsePolicy;
  expires_at?: string | null;
}

export interface KnowledgeDocument {
  id: string;
  workspace_id: string;
  title: string;
  source_type: string;
  source_url: string | null;
  attachment_id: string | null;
  status: KnowledgeDocumentStatus;
  imported_by: string | null;
  metadata: unknown;
  last_indexed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListKnowledgeDocumentsParams {
  status?: KnowledgeDocumentStatus;
  limit?: number;
  offset?: number;
}

export interface ListKnowledgeDocumentsResponse {
  documents: KnowledgeDocument[];
  total: number;
}

export interface CreateKnowledgeDocumentRequest {
  title: string;
  source_type: string;
  source_url?: string;
  attachment_id?: string;
  status?: KnowledgeDocumentStatus;
  metadata?: unknown;
}
