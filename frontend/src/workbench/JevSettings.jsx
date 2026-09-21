import { useEffect, useRef, useState } from "react";
import { Button } from "../../vendor/zcode/packages/ui/src/components/ui/button.tsx";
import { Input } from "../../vendor/zcode/packages/ui/src/components/ui/input.tsx";
import { desktopBrowserAvailable } from "./browser-session.js";

/** 沿用模型设置的卡片/表单；凭据只传给主进程，由后端 keyring 持久化。 */
export function JevSettings() {
  const browser = desktopBrowserAvailable(window.aiMeDesktop) ? window.aiMeDesktop.browser : null;
  const [config, setConfig] = useState(null);
  const [model, setModel] = useState("jev-latest");
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!browser) return;
    let active = true;
    locked.current = true;
    setBusy(true);
    setError("");
    browser.run("", "config", {}).then((value) => {
      if (!active) return;
      setConfig(value);
      setModel(value.model || "jev-latest");
    }).catch(() => { if (active) setError("Jev 配置读取失败，请重试。"); }).finally(() => {
      if (active) { locked.current = false; setBusy(false); }
    });
    return () => { active = false; };
  }, [browser, revision]);
  if (!browser) return null;
  async function save(event) {
    event.preventDefault();
    if (locked.current || !model.trim()) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setSuccess("");
    // 提交即清空输入，即使服务端失败也不在 UI 长时间保留密钥。
    const input = { model: model.trim(), ...(clearApiKey ? { clearApiKey: true } : apiKey ? { apiKey } : {}) };
    setApiKey("");
    try {
      const value = await browser.run("", "configure", input);
      setConfig(value);
      setModel(value.model || "jev-latest");
      setClearApiKey(false);
      setSuccess("Jev 配置已保存");
    } catch {
      // 不展示未经脱敏的 IPC 错误，避免服务端回显请求中的密钥。
      setError("Jev 配置保存失败，请重试；如需更新密钥，请重新输入。");
    } finally { locked.current = false; setBusy(false); }
  }
  return <form onSubmit={save} data-testid="jev-settings" className="rounded-xl border border-border bg-card p-4">
    <div className="mb-4 flex items-center justify-between"><h3 className="font-medium">Jev 浏览器模型</h3>
      <Button type="button" variant="ghost" disabled={busy} onClick={() => setRevision((value) => value + 1)}>刷新 Jev 配置</Button></div>
    <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-2"><span>Jev 模型名称</span><Input data-testid="jev-model" required value={model} onChange={(event) => setModel(event.target.value)} /></label>
      <label className="flex flex-col gap-2"><span>Jev API Key</span><Input data-testid="jev-api-key" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} disabled={clearApiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config?.configured ? "已配置，留空保留原密钥" : "输入 Jev API Key"} /></label>
      <p data-testid="jev-config-status" role="status" className="text-sm text-muted-foreground sm:col-span-2">{config ? config.configured ? "Jev 密钥已配置" : "Jev 密钥未配置" : busy ? "正在读取 Jev 配置…" : "Jev 配置读取失败"}</p>
      {config?.configured && <label className="flex items-center gap-2 sm:col-span-2"><input data-testid="jev-clear-key" type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); setApiKey(""); }} />保存时清除已存密钥</label>}
      <p className="text-sm text-muted-foreground sm:col-span-2">密钥由后端保存到系统凭据库，保存后不回显。普通文字输入复用已有模型，无需额外密钥。</p>
      {config && !config.textConfigured && <p className="text-sm text-muted-foreground sm:col-span-2">请同时配置上方的文字模型。</p>}
      {config?.bridgeConnected === false && <p className="text-sm text-muted-foreground sm:col-span-2">浏览器桥接未连接，请检查桌面服务。</p>}
      {error && <p role="alert" className="text-destructive sm:col-span-2">{error}</p>}
      {success && <p role="status" className="sm:col-span-2">{success}</p>}
      <Button data-testid="jev-save" type="submit" disabled={!config || !model.trim()} className="justify-self-start">{busy ? "正在处理…" : "保存 Jev 配置"}</Button>
    </fieldset>
  </form>;
}
