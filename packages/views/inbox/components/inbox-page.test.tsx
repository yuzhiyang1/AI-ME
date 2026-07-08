import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type { InboxItem } from "@multica/core/types";
import enCommon from "../../locales/en/common.json";
import enInbox from "../../locales/en/inbox.json";

const TEST_RESOURCES = { en: { common: enCommon, inbox: enInbox } };

const mockNavigation = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
}));

const mockApi = vi.hoisted(() => ({
  listInbox: vi.fn(),
  markInboxRead: vi.fn().mockResolvedValue(undefined),
  archiveInbox: vi.fn().mockResolvedValue(undefined),
  markAllInboxRead: vi.fn().mockResolvedValue(undefined),
  archiveAllInbox: vi.fn().mockResolvedValue(undefined),
  archiveAllReadInbox: vi.fn().mockResolvedValue(undefined),
  archiveCompletedInbox: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@multica/core/api", () => ({
  api: mockApi,
  getApi: () => mockApi,
  setApiInstance: vi.fn(),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/paths")>(
    "@multica/core/paths",
  );
  return {
    ...actual,
    useWorkspacePaths: () => actual.paths.workspace("test"),
  };
});

vi.mock("@multica/core/aime", () => ({
  useThinkAIMe: () => ({
    mutateAsync: vi.fn(),
  }),
}));

vi.mock("@multica/core/modals", () => ({
  useModalStore: Object.assign(
    () => ({ open: vi.fn() }),
    { getState: () => ({ open: vi.fn() }) },
  ),
}));

vi.mock("@multica/core/issues/stores/draft-store", () => ({
  useIssueDraftStore: Object.assign(
    () => ({ setDraft: vi.fn() }),
    { getState: () => ({ setDraft: vi.fn() }) },
  ),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: () => "Test Actor",
    getActorInitials: () => "TA",
    getActorAvatarUrl: () => null,
  }),
}));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    searchParams: mockNavigation.searchParams,
    push: mockNavigation.push,
    replace: mockNavigation.replace,
    back: vi.fn(),
    pathname: "/test/inbox",
    getShareableUrl: (path: string) => `https://app.multica.test${path}`,
  }),
  NavigationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../../issues/components", () => ({
  IssueDetail: ({ issueId }: { issueId: string }) => (
    <div data-testid="issue-detail">{issueId}</div>
  ),
  StatusIcon: ({ status }: { status: string }) => (
    <span data-testid="status-icon">{status}</span>
  ),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
}));

vi.mock("@multica/ui/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Panel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Separator: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { InboxPage } from "./inbox-page";

function makeInboxItem(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: "inbox-1",
    workspace_id: "ws-1",
    recipient_type: "member",
    recipient_id: "member-1",
    actor_type: "agent",
    actor_id: "agent-1",
    type: "new_comment",
    severity: "info",
    issue_id: "issue-1",
    title: "Inbox notification",
    body: null,
    issue_status: null,
    read: true,
    archived: false,
    created_at: "2026-07-01T12:00:00Z",
    details: null,
    ...overrides,
  };
}

function renderInboxPage(items: InboxItem[], search: string) {
  mockNavigation.searchParams = new URLSearchParams(search);
  mockApi.listInbox.mockResolvedValue(items);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <InboxPage />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("InboxPage URL selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigation.searchParams = new URLSearchParams();
    mockApi.listInbox.mockResolvedValue([]);
  });

  it("selects the inbox item associated with ?issue=", async () => {
    renderInboxPage(
      [
        makeInboxItem({ id: "inbox-a", issue_id: "issue-a", title: "First" }),
        makeInboxItem({ id: "inbox-b", issue_id: "issue-b", title: "Target" }),
      ],
      "issue=issue-b",
    );

    expect(await screen.findByTestId("issue-detail")).toHaveTextContent("issue-b");
  });

  it("selects the exact item for ?inbox=", async () => {
    renderInboxPage(
      [
        makeInboxItem({ id: "inbox-a", issue_id: "issue-a", title: "First" }),
        makeInboxItem({
          id: "inbox-standalone",
          issue_id: null,
          type: "task_failed",
          title: "Standalone exception",
        }),
      ],
      "inbox=inbox-standalone",
    );

    expect(
      await screen.findByRole("heading", { name: "Standalone exception" }),
    ).toBeInTheDocument();
  });

  it("keeps old ?issue links working for inbox items without an issue", async () => {
    renderInboxPage(
      [
        makeInboxItem({
          id: "legacy-standalone",
          issue_id: null,
          type: "quick_create_failed",
          title: "Legacy standalone exception",
        }),
      ],
      "issue=legacy-standalone",
    );

    expect(
      await screen.findByRole("heading", { name: "Legacy standalone exception" }),
    ).toBeInTheDocument();
  });

  it("opens the linked AI approval from approval-backed inbox items", async () => {
    renderInboxPage(
      [
        makeInboxItem({
          id: "approval-inbox",
          issue_id: null,
          type: "review_requested",
          title: "是否发送飞书回复",
          body: "批准后将回复发送到飞书原消息。",
          severity: "action_required",
          details: {
            approval_id: "approval-1",
            channel: "feishu",
            reply_preview: "您好，退款问题我已经收到。",
          },
        }),
      ],
      "inbox=approval-inbox",
    );

    expect(await screen.findByText("AI-Me 已生成审批事项")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /去审批中心/ }));

    expect(mockNavigation.push).toHaveBeenCalledWith(
      "/test/approvals?approval=approval-1",
    );
  });
});
