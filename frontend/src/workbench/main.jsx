// AI-ME 宿主入口：加载固定版本 ZCode 的真实组件及 Tailwind 样式。
import { createRoot } from "react-dom/client";
import { Root } from "../../vendor/zcode/packages/ui/src/Root.tsx";
import { ZCodeIntlProvider } from "../../vendor/zcode/packages/ui/src/i18n/IntlProvider.tsx";
import { AppErrorBoundary } from "../../vendor/zcode/packages/ui/src/ErrorBoundary.tsx";
import "../../vendor/zcode/packages/ui/src/styles.css";
import { createHost } from "./services.js";
import { desktopRootProps } from "./desktop-platform.js";
import { ServiceProvider } from "../../vendor/zcode/packages/ui/src/hooks/useServices.tsx";
import { LocalSetup } from "./LocalSetup.jsx";
import { PlatformProvider } from "../../vendor/zcode/packages/ui/src/hooks/usePlatform.tsx";
import { setHostWorkspaceLabelResolver } from "../../vendor/zcode/packages/ui/src/lib/hostWorkspaceLabel.ts";
import { ProjectWorkspaceBridge } from "./ProjectWorkspaceBridge.jsx";
import { ProjectManager } from "./ProjectManager.jsx";

document.documentElement.classList.add("theme-zai-light");
const desktopProps = desktopRootProps(window.aiMeDesktop);
document.documentElement.classList.toggle(
  "platform-windows-desktop",
  desktopProps.isWindowsDesktop,
);
const root = createRoot(document.getElementById("root"));
async function start() {
  const host = await createHost();
  const { services, platform, workspacePath } = host;
  setHostWorkspaceLabelResolver((key) => host.directory.label(key));
  root.render(
    <AppErrorBoundary {...desktopProps}>
      <ZCodeIntlProvider
        settingService={services.settingService}
        broadcastService={services.broadcastService}
      >
        {workspacePath ? (
          <Root
            {...desktopProps}
            services={services}
            platform={platform}
            initialWorkspaceAbsPath={workspacePath}
            hostManagedProviders
            restoreSession={false}
            allowRemoteWorkspace={false}
            supportsEmbeddedBrowser={false}
            hostAddon={<ProjectWorkspaceBridge host={host} />}
          />
        ) : (
          <ServiceProvider services={services}>
            <PlatformProvider platform={platform}>
              <LocalSetup
                {...desktopProps}
                services={services}
                platform={platform}
                onReady={() => window.location.reload()}
              />
              <ProjectManager host={host} />
            </PlatformProvider>
          </ServiceProvider>
        )}
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
}
start().catch((error) =>
  root.render(<div role="alert">AI-ME 工作台启动失败：{error.message}</div>),
);
