import { useState } from "react";
import { Button } from "../../vendor/zcode/packages/ui/src/components/ui/button.tsx";
import { LocalModelSettings } from "./LocalModelSettings.jsx";
import { DesktopWindowControls } from "../../vendor/zcode/packages/ui/src/DesktopWindowControls.tsx";

/** 首次使用只选择已有本地目录，不创建 ZCode 默认目录或请求商业账号。 */
export function LocalSetup({
  services,
  platform,
  onReady,
  isWindowsDesktop = false,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function chooseWorkspace() {
    setBusy(true);
    setError("");
    try {
      const path = await platform.selectDirectory();
      if (!path) return;
      const settings = await services.settingService.get();
      await services.settingService.update({
        recentProjects: [
          path,
          ...(settings.recentProjects ?? []).filter((item) => item !== path),
        ],
      });
      onReady();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="h-full overflow-y-auto bg-background text-foreground">
      {isWindowsDesktop && (
        <div className="sticky top-0 z-10 flex h-12 items-center justify-end bg-background px-2 [app-region:drag]">
          <DesktopWindowControls />
        </div>
      )}
      <div className="mx-auto max-w-3xl space-y-8 p-8">
        <header className="space-y-3">
          <h1 className="text-xl font-semibold">开始使用 AI-ME</h1>
          <p>配置模型后，选择一个本地工作区即可进入工作台。</p>
          <Button onClick={chooseWorkspace} disabled={busy}>
            {busy ? "正在选择…" : "选择工作区并进入"}
          </Button>
          {error && <p role="alert">{error}</p>}
        </header>
        <LocalModelSettings />
      </div>
    </main>
  );
}
