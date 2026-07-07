import { type ChangeEvent, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enChat from "../../locales/en/chat.json";
import { ChatWindow } from "./chat-window";

const mockCreateSession = vi.hoisted(() => vi.fn());
const mockSendChatMessage = vi.hoisted(() => vi.fn());
const mockMarkRead = vi.hoisted(() => ({ mutate: vi.fn() }));
const mockDeleteSession = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const mockSetOpen = vi.hoisted(() => vi.fn());
const mockSetActiveSession = vi.hoisted(() => vi.fn());
const mockSetSelectedAgentId = vi.hoisted(() => vi.fn());

const mockChatStore = {
  isOpen: true,
  activeSessionId: null as string | null,
  selectedAgentId: "agent-1" as string | null,
  isExpanded: false,
  focusMode: false,
  inputDrafts: {} as Record<string, string>,
  setOpen: mockSetOpen,
  setActiveSession: mockSetActiveSession,
  setSelectedAgentId: mockSetSelectedAgentId,
  setInputDraft: vi.fn((key: string, value: string) => {
    mockChatStore.inputDrafts[key] = value;
  }),
  clearInputDraft: vi.fn((key: string) => {
    delete mockChatStore.inputDrafts[key];
  }),
};

const mockDesktopAPI = vi.hoisted(() => ({ selectDirectory: vi.fn() }));

const sessionDefault = {
  id: "session-1",
  workspace_id: "ws-test",
  agent_id: "agent-1",
  creator_id: "user-1",
  title: "Existing session",
  status: "active" as const,
  code_context: { type: "local_path" as const, path: "C:\\existing" },
  has_unread: false,
  created_at: "2026-05-09T00:00:00Z",
  updated_at: "2026-05-09T00:00:00Z",
};

const mockQueryState = {
  agents: [{ id: "agent-1", name: "Bohan", archived_at: null, runtime_id: "runtime-1", owner_id: "user-1", runtime_mode: "local" as const }],
  members: [{ user_id: "user-1", role: "admin" }],
  sessions: [] as typeof sessionDefault[],
  messages: [] as Array<{ id: string; chat_session_id: string; role: "user" | "assistant"; content: string; task_id: string | null; created_at: string }>,
  pendingTask: {} as { task_id?: string; status?: string; created_at?: string },
  pendingTasks: { tasks: [] as Array<{ task_id: string; chat_session_id: string; status: string }> },
};

vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<"div">) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-test",
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector?: (state: { user: { id: string } }) => unknown) =>
    (selector ? selector({ user: { id: "user-1" } }) : { user: { id: "user-1" } }),
}));

vi.mock("@multica/core/workspace/queries", () => ({
  agentListOptions: () => ({ queryKey: ["agents"] }),
  memberListOptions: () => ({ queryKey: ["members"] }),
}));

vi.mock("@multica/views/issues/components", () => ({
  canAssignAgent: () => true,
}));

vi.mock("@multica/core/api", () => ({
  api: {
    sendChatMessage: mockSendChatMessage,
    cancelTaskById: vi.fn(),
  },
}));

vi.mock("@multica/core/agents", () => ({
  useAgentPresenceDetail: () => ({ availability: "online" }),
  useWorkspaceAgentAvailability: () => "available",
}));

vi.mock("@multica/core/chat/queries", () => ({
  chatKeys: {
    messages: (sessionId: string) => ["chat", "messages", sessionId],
    pendingTask: (sessionId: string) => ["chat", "pending-task", sessionId],
    sessions: (wsId: string) => ["chat", wsId, "sessions"],
  },
  chatSessionsOptions: () => ({ queryKey: ["sessions"] }),
  chatMessagesOptions: (sessionId: string) => ({ queryKey: ["messages", sessionId] }),
  pendingChatTaskOptions: (sessionId: string) => ({ queryKey: ["pending-task", sessionId] }),
  pendingChatTasksOptions: () => ({ queryKey: ["pending-tasks"] }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: ({ queryKey }: { queryKey: string[] }) => {
      switch (queryKey[0]) {
        case "agents":
          return { data: mockQueryState.agents };
        case "members":
          return { data: mockQueryState.members };
        case "sessions":
          return { data: mockQueryState.sessions };
        case "messages":
          return { data: mockQueryState.messages, isLoading: false };
        case "pending-task":
          return { data: mockQueryState.pendingTask };
        case "pending-tasks":
          return { data: mockQueryState.pendingTasks };
        default:
          return { data: [] };
      }
    },
  };
});

vi.mock("@multica/core/chat/mutations", () => ({
  useCreateChatSession: () => ({
    mutateAsync: mockCreateSession,
  }),
  useMarkChatSessionRead: () => mockMarkRead,
  useDeleteChatSession: () => mockDeleteSession,
}));

vi.mock("@multica/core/chat", () => ({
  DRAFT_NEW_SESSION: "draft:new",
  useChatStore: Object.assign(
    (selector: (state: typeof mockChatStore) => unknown) => selector(mockChatStore),
    { getState: () => mockChatStore },
  ),
}));

vi.mock("@multica/core/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
}));

vi.mock("./offline-banner", () => ({
  OfflineBanner: () => <div>Offline banner</div>,
}));

vi.mock("./no-agent-banner", () => ({
  NoAgentBanner: () => <div>No agent banner</div>,
}));

vi.mock("./chat-message-list", () => ({
  ChatMessageList: () => <div>Messages</div>,
  ChatMessageSkeleton: () => <div>Loading</div>,
}));

vi.mock("./context-anchor", () => ({
  ContextAnchorButton: () => <button type="button">Anchor</button>,
  ContextAnchorCard: () => <div>Anchor card</div>,
  buildAnchorMarkdown: (candidate: { label: string }) => `anchor:${candidate.label}`,
  useRouteAnchorCandidate: () => ({ candidate: null }),
}));

vi.mock("./chat-resize-handles", () => ({
  ChatResizeHandles: () => null,
}));

vi.mock("./use-chat-resize", () => ({
  useChatResize: () => ({
    renderWidth: 480,
    renderHeight: 640,
    isAtMax: false,
    boundsReady: true,
    isDragging: false,
    toggleExpand: vi.fn(),
    startDrag: vi.fn(),
  }),
}));

vi.mock("./chat-input", () => ({
  ChatInput: ({
    onSend,
    disabled,
    noAgent,
    agentName,
  }: {
    onSend: (content: string) => void;
    disabled?: boolean;
    noAgent?: boolean;
    agentName?: string;
  }) => (
    <div>
      <button
        type="button"
        disabled={disabled || noAgent}
        onClick={() => onSend("Please inspect this")}
      >
        {agentName ? `Send to ${agentName}` : "Send"}
      </button>
    </div>
  ),
}));

vi.mock("@multica/ui/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    className,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    className?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  ),
}));

vi.mock("@multica/ui/components/ui/input", () => ({
  Input: ({
    value,
    disabled,
    readOnly,
    placeholder,
    className,
    onChange,
  }: {
    value?: string;
    disabled?: boolean;
    readOnly?: boolean;
    placeholder?: string;
    className?: string;
    onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  }) => (
    <input
      value={value}
      disabled={disabled}
      readOnly={readOnly}
      placeholder={placeholder}
      className={className}
      onChange={onChange}
    />
  ),
}));

vi.mock("@multica/ui/components/ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (v: boolean) => void;
  }) => (
    <input
      aria-label="Code context switch"
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => <>{render ?? children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@multica/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children, className }: { children: ReactNode; className?: string }) => (
    <button type="button" className={className}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onClick, className }: { children: ReactNode; onClick?: (event: MouseEvent<HTMLButtonElement>) => void; className?: string }) => (
    <button type="button" onClick={onClick} className={className}>{children}</button>
  ),
}));

vi.mock("@multica/ui/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  AlertDialogAction: ({ children, onClick, disabled, className }: { children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) => (
    <button type="button" onClick={onClick} disabled={disabled} className={className}>{children}</button>
  ),
  AlertDialogCancel: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => (
    <button type="button" disabled={disabled}>{children}</button>
  ),
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const TEST_RESOURCES = { en: { common: enCommon, chat: enChat } };

function renderWindow() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ChatWindow />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("ChatWindow code context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "desktopAPI", {
      configurable: true,
      value: mockDesktopAPI,
    });
    mockDesktopAPI.selectDirectory.mockResolvedValue("C:\\repo");
    mockQueryState.sessions = [];
    mockQueryState.messages = [];
    mockQueryState.pendingTask = {};
    mockQueryState.pendingTasks = { tasks: [] };
    mockQueryState.agents = [
      { id: "agent-1", name: "Bohan", archived_at: null, runtime_id: "runtime-1", owner_id: "user-1", runtime_mode: "local" as const },
    ];
    mockChatStore.isOpen = true;
    mockChatStore.activeSessionId = null;
    mockChatStore.selectedAgentId = "agent-1";
    mockChatStore.inputDrafts = {};
    mockCreateSession.mockResolvedValue({ id: "new-session" });
    mockSendChatMessage.mockResolvedValue({
      message_id: "msg-1",
      task_id: "task-1",
      created_at: "2026-05-09T00:00:00Z",
    });
  });

  it("sends new session code_context on first message", async () => {
    const user = userEvent.setup();
    renderWindow();

    await user.click(screen.getByLabelText("Code context switch"));
    await user.click(screen.getByRole("button", { name: "Choose" }));
    await user.click(screen.getByRole("button", { name: "Send to Bohan" }));

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith({
        agent_id: "agent-1",
        title: "Please inspect this",
        code_context: { type: "local_path", path: "C:\\repo" },
      });
    });
  });

  it("shows existing session code context in locked mode", () => {
    mockChatStore.activeSessionId = "session-1";
    mockQueryState.sessions = [sessionDefault];

    renderWindow();

    expect(screen.getByDisplayValue("C:\\existing")).toBeDisabled();
    expect(
      screen.getByText(
        "This chat session keeps using the code source selected when it was created. Start a new session to change it.",
      ),
    ).toBeInTheDocument();
  });
});
