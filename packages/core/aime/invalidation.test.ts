import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { agentTaskSnapshotKeys } from "../agents/queries";
import { approvalKeys } from "../approvals/queries";
import { inboxKeys } from "../inbox/queries";
import { issueKeys } from "../issues/queries";
import { memoryKeys } from "../memory/queries";
import { invalidateAIMeWorkSurface } from "./invalidation";
import { aimeKeys } from "./queries";

describe("invalidateAIMeWorkSurface", () => {
  it("invalidates every cache slice rendered by the AI-Me cockpit", () => {
    const qc = new QueryClient();
    const wsId = "workspace-1";
    const keys = [
      aimeKeys.cockpitSummary(wsId),
      approvalKeys.list(wsId, { status: "pending", limit: 20 }),
      inboxKeys.list(wsId),
      issueKeys.list(wsId),
      agentTaskSnapshotKeys.list(wsId),
      memoryKeys.list(wsId, { status: "candidate", limit: 12 }),
    ];

    for (const key of keys) {
      qc.setQueryData(key, { ok: true });
    }

    invalidateAIMeWorkSurface(qc, wsId);

    for (const key of keys) {
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });
});
