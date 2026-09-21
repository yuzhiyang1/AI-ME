import { useEffect, useState } from "react";
import { useServices } from "../../vendor/zcode/packages/ui/src/hooks/useServices.tsx";
import { Button } from "../../vendor/zcode/packages/ui/src/components/ui/button.tsx";
import { Input } from "../../vendor/zcode/packages/ui/src/components/ui/input.tsx";

// 沿用 AI-ME 原有配置协议；预设只是可编辑的表单初值，不代表账号套餐。
export const modelPresets = {
  deepseek: {
    provider: "deepseek",
    modelId: "deepseek-chat",
    displayName: "DeepSeek Chat",
    protocol: "openai_completions",
    baseUrl: "https://api.deepseek.com/v1",
    contextWindow: 128000,
  },
  openai: {
    provider: "openai",
    modelId: "gpt-4o",
    displayName: "GPT-4o",
    protocol: "openai_completions",
    baseUrl: "",
    contextWindow: 128000,
  },
  anthropic: {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    protocol: "anthropic_messages",
    baseUrl: "",
    contextWindow: 200000,
  },
  custom: {
    provider: "custom",
    modelId: "",
    displayName: "",
    protocol: "openai_completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    contextWindow: 128000,
  },
};
const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

/** 仅调用 AI-ME 后端；密钥只在提交时发送，既不回显也不写入浏览器持久存储。 */
export function LocalModelSettings() {
  const { providerSettingsService } = useServices();
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [preset, setPreset] = useState("deepseek");
  const [form, setForm] = useState(modelPresets.deepseek);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    providerSettingsService
      .listLocalConfigurations()
      .then(
        (items) => {
          if (active) setModels(items);
        },
        (cause) => {
          if (active) setLoadError(cause.message);
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [providerSettingsService, reload]);
  const update = (key, value) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  async function save(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const result = await providerSettingsService.createLocalConfiguration({
        ...form,
        provider: form.provider.trim(),
        modelId: form.modelId.trim(),
        displayName: form.displayName.trim(),
        baseUrl: form.baseUrl.trim() || null,
        apiKey,
      });
      setApiKey("");
      setSuccess(
        result.refreshError
          ? `配置已保存，但模型列表刷新失败：${result.refreshError}。请点击刷新列表，不要重复提交。`
          : `${result.configuration.displayName} 已可用于新会话`,
      );
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section
      className="space-y-6 text-foreground"
      data-testid="ai-me-model-settings"
    >
      <header>
        <h2 className="text-lg font-semibold">模型配置</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          使用自己的模型与 API Key，无需登录 AI-ME
          账号，无需订阅套餐。保存后立即生效。
        </p>
      </header>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">已配置模型</h3>
          <Button
            variant="ghost"
            disabled={loading || saving}
            onClick={async () => {
              try {
                await providerSettingsService.refresh();
                setSuccess("");
              } catch (cause) {
                setError(cause.message);
              }
              setReload((value) => value + 1);
            }}
          >
            刷新列表
          </Button>
        </div>
        {loading ? (
          <p role="status">正在读取模型配置…</p>
        ) : loadError ? (
          <p role="alert">{loadError}</p>
        ) : models.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂无模型，请在下方添加。
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {models.map((model) => (
              <li
                key={model.id}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div>
                  <div className="font-medium">{model.displayName}</div>
                  <div className="text-sm text-muted-foreground">
                    {model.modelRef}
                  </div>
                </div>
                <span className="text-sm">
                  {model.credentialStored ? "密钥已保存" : "密钥缺失"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form
        onSubmit={save}
        className="rounded-xl border border-border bg-card p-4"
      >
        <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-4 font-medium">新增模型</legend>
          <label className="flex flex-col gap-2 sm:col-span-2">
            <span>快速配置</span>
            <select
              className={selectClass}
              value={preset}
              onChange={(event) => {
                setPreset(event.target.value);
                setForm(modelPresets[event.target.value]);
                setApiKey("");
                setError("");
                setSuccess("");
              }}
            >
              <option value="deepseek">DeepSeek</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="custom">OpenAI 兼容服务</option>
            </select>
          </label>
          {[
            ["provider", "厂商标识"],
            ["modelId", "模型 ID"],
            ["displayName", "显示名称"],
          ].map(([key, label]) => (
            <label key={key} className="flex flex-col gap-2">
              <span>{label}</span>
              <Input
                required
                value={form[key]}
                onChange={(event) => update(key, event.target.value)}
              />
            </label>
          ))}
          <label className="flex flex-col gap-2">
            <span>协议</span>
            <select
              className={selectClass}
              value={form.protocol}
              onChange={(event) => update("protocol", event.target.value)}
            >
              <option value="openai_completions">Chat Completions</option>
              <option value="anthropic_messages">Anthropic Messages</option>
            </select>
          </label>
          <label className="flex flex-col gap-2 sm:col-span-2">
            <span>API 地址（可选）</span>
            <Input
              type="url"
              value={form.baseUrl}
              onChange={(event) => update("baseUrl", event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span>API Key</span>
            <Input
              required
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span>上下文窗口（tokens）</span>
            <Input
              required
              type="number"
              min="1"
              max="10000000"
              step="1"
              value={form.contextWindow}
              onChange={(event) =>
                update("contextWindow", Number(event.target.value))
              }
            />
          </label>
          <p className="text-sm text-muted-foreground sm:col-span-2">
            API Key 由 AI-ME 后端保存到系统凭据库，不会在列表中回显。
          </p>
          {error && (
            <p role="alert" className="text-destructive sm:col-span-2">
              {error}
            </p>
          )}
          {success && (
            <p role="status" className="sm:col-span-2">
              {success}
            </p>
          )}
          <Button type="submit" className="justify-self-start">
            {saving ? "正在保存…" : "保存并启用"}
          </Button>
        </fieldset>
      </form>
    </section>
  );
}
export const ModelProviderSection = LocalModelSettings;
