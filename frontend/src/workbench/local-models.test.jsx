// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  renderHook,
} from "@testing-library/react";
import { ServiceProvider } from "../../vendor/zcode/packages/ui/src/hooks/useServices.tsx";
import { LocalModelSettings } from "./LocalModelSettings.jsx";
import { LocalSetup } from "./LocalSetup.jsx";
import { createHost } from "./services.js";
import * as api from "../api.ts";
import {
  CodingPlanUpgradeDialogProvider,
  CodingPlanEntryButton,
  useCodingPlanUpgradeDialog,
  useRootOAuthEffects,
  ConversationQuotaBanner,
} from "./local-account.jsx";

vi.mock("../api.ts", () => ({
  listModels: vi.fn(),
  listSessions: vi.fn(),
  listProjects: vi.fn(),
  listModelConfigurations: vi.fn(),
  createModelConfiguration: vi.fn(),
}));
const model = {
  ref: "custom/test",
  provider: "custom",
  modelId: "test",
  displayName: "本地测试",
  contextWindow: 128000,
};
const configuration = {
  id: "m1",
  modelRef: model.ref,
  displayName: model.displayName,
  credentialStored: true,
};
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  api.listModels.mockResolvedValue([]);
  api.listSessions.mockResolvedValue([]);
  api.listProjects.mockResolvedValue([]);
  api.listModelConfigurations.mockResolvedValue([]);
  api.createModelConfiguration.mockResolvedValue(configuration);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AI-ME 本地模型与账号边界", () => {
  it("首次使用无需账号，取消目录选择不写入偏好，选中后再进入", async () => {
    const { services } = await createHost();
    const platform = {
      selectDirectory: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("D:/workspace"),
    };
    const onReady = vi.fn();
    render(
      <ServiceProvider services={services}>
        <LocalSetup services={services} platform={platform} onReady={onReady} />
      </ServiceProvider>,
    );
    await screen.findByText("暂无模型，请在下方添加。");
    fireEvent.click(screen.getByText("选择工作区并进入"));
    await waitFor(() =>
      expect(platform.selectDirectory).toHaveBeenCalledTimes(1),
    );
    expect(onReady).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText("选择工作区并进入"));
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect((await services.settingService.get()).recentProjects[0]).toBe(
      "D:/workspace",
    );
  });

  it("保存等待旧的刷新结束，再读取新目录，不被启动时旧请求覆盖", async () => {
    const { services } = await createHost();
    let finishOldRead;
    api.listModels
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOldRead = resolve;
        }),
      )
      .mockResolvedValue([model]);
    const oldRefresh = services.providerSettingsService.refresh();
    const save = services.providerSettingsService.createLocalConfiguration({
      apiKey: "test-only",
    });
    finishOldRead([]);
    await Promise.all([oldRefresh, save]);
    expect(
      (await services.modelSelectionService.getView()).effectiveSelection
        .modelId,
    ).toBe("test");
    expect(api.listModels).toHaveBeenCalledTimes(3);
  });
  it("不挂载付费入口、弹窗或 OAuth 恢复/轮询", () => {
    const services = { oauthService: { restoreCachedSessionState: vi.fn() } };
    const state = {
      services,
      setUser: vi.fn(),
      setIsRestoringOAuthSession: vi.fn(),
      setOAuthPollingActive: vi.fn(),
      setOAuthError: vi.fn(),
    };
    renderHook(() => useRootOAuthEffects(state));
    expect(
      services.oauthService.restoreCachedSessionState,
    ).not.toHaveBeenCalled();
    expect(state.setIsRestoringOAuthSession).toHaveBeenCalledWith(false);
    expect(state.setUser).toHaveBeenCalledWith(null);
    render(
      <CodingPlanUpgradeDialogProvider>
        <span>本地工作台</span>
        <CodingPlanEntryButton>升级套餐</CodingPlanEntryButton>
        <ConversationQuotaBanner state={{ visible: true }} />
      </CodingPlanUpgradeDialogProvider>,
    );
    expect(screen.queryByText("升级套餐")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      useCodingPlanUpgradeDialog().openCodingPlanUpgrade({ providerId: "zai" }),
    ).toBe(false);
  });

  it("保存后同步更新模型目录和 V4 工作区配置，密钥不进入投影或存储", async () => {
    vi.useFakeTimers();
    const { services } = await createHost();
    const modelListener = vi.fn();
    services.modelSelectionService.onDidChange(modelListener);
    const frames = vi.fn();
    services.zcodeAgentService.onDynamicWorkspaceConfigFrame()(frames);
    const { ack } = await services.zcodeAgentService.subscribeWorkspaceConfigV4(
      { workspacePath: "D:/test" },
    );
    await vi.advanceTimersByTimeAsync(1);
    api.listModels.mockResolvedValue([model]);
    await services.providerSettingsService.createLocalConfiguration({
      apiKey: "secret-test-only",
    });

    expect(modelListener.mock.lastCall[0].providers[0].models[0].modelId).toBe(
      "test",
    );
    expect(JSON.stringify(frames.mock.lastCall)).toContain("custom/test");
    expect(JSON.stringify(modelListener.mock.calls)).not.toContain(
      "secret-test-only",
    );
    expect(JSON.stringify(localStorage)).not.toContain("secret-test-only");
    await services.zcodeAgentService.unsubscribeWorkspaceConfigV4({
      subscriptionId: ack.subscriptionId,
    });
  });

  it("模型刷新失败保留旧目录，写入成功不伪装成提交失败", async () => {
    api.listModels.mockResolvedValue([model]);
    const { services } = await createHost();
    api.listModels.mockRejectedValue(new Error("网络不可用"));
    const result =
      await services.providerSettingsService.createLocalConfiguration({
        apiKey: "test-only",
      });
    expect(result.configuration).toEqual(configuration);
    expect(result.refreshError).toBe("网络不可用");
    expect(
      (await services.modelSelectionService.getView()).effectiveSelection
        .modelId,
    ).toBe("test");
    expect(api.createModelConfiguration).toHaveBeenCalledTimes(1);
  });

  it("空模型表单保存后清空密钥并显示已配置模型", async () => {
    const { services } = await createHost();
    render(
      <ServiceProvider services={services}>
        <LocalModelSettings />
      </ServiceProvider>,
    );
    await screen.findByText("暂无模型，请在下方添加。");
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "test-key" },
    });
    api.listModels.mockResolvedValue([model]);
    api.listModelConfigurations.mockResolvedValue([configuration]);
    fireEvent.click(screen.getByRole("button", { name: "保存并启用" }));
    await screen.findByText("本地测试 已可用于新会话");
    expect(screen.getByLabelText("API Key").value).toBe("");
    await screen.findByText("密钥已保存");
    expect(api.createModelConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "openai_completions",
        apiKey: "test-key",
      }),
    );
  });

  it("提交失败保持可重试，切换预设不把旧密钥带给另一厂商", async () => {
    const { services } = await createHost();
    render(
      <ServiceProvider services={services}>
        <LocalModelSettings />
      </ServiceProvider>,
    );
    await screen.findByText("暂无模型，请在下方添加。");
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "test-key" },
    });
    api.createModelConfiguration.mockRejectedValue(new Error("保存失败"));
    fireEvent.click(screen.getByRole("button", { name: "保存并启用" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("API Key").value).toBe("test-key");
    fireEvent.change(screen.getByLabelText("快速配置"), {
      target: { value: "anthropic" },
    });
    expect(screen.getByLabelText("API Key").value).toBe("");
    expect(screen.getByLabelText("协议").value).toBe("anthropic_messages");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("读取失败不伪装为空列表，用户可显式重试", async () => {
    const { services } = await createHost();
    api.listModelConfigurations.mockRejectedValueOnce(
      new Error("配置读取失败"),
    );
    render(
      <ServiceProvider services={services}>
        <LocalModelSettings />
      </ServiceProvider>,
    );
    await screen.findByText("配置读取失败");
    expect(screen.queryByText("暂无模型，请在下方添加。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await screen.findByText("暂无模型，请在下方添加。");
  });
});
