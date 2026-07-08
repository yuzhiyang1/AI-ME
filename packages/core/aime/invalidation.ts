import type { QueryClient } from "@tanstack/react-query";
import { agentTaskSnapshotKeys } from "../agents/queries";
import { approvalKeys } from "../approvals/queries";
import { inboxKeys } from "../inbox/queries";
import { issueKeys } from "../issues/queries";
import { memoryKeys } from "../memory/queries";
import { aimeKeys } from "./queries";

// The AI-Me cockpit is a stitched surface: summary metrics, pending approvals,
// inbox exceptions, active worker tasks, related issues, and candidate memory.
// Invalidate the whole dependency set after user-facing handling actions so the
// cockpit reflects the new operational state immediately.
export function invalidateAIMeWorkSurface(qc: QueryClient, wsId: string) {
  qc.invalidateQueries({ queryKey: aimeKeys.all(wsId) });
  qc.invalidateQueries({ queryKey: approvalKeys.all(wsId) });
  qc.invalidateQueries({ queryKey: inboxKeys.all(wsId) });
  qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
  qc.invalidateQueries({ queryKey: agentTaskSnapshotKeys.all(wsId) });
  qc.invalidateQueries({ queryKey: memoryKeys.all(wsId) });
}
