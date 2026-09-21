import { useEffect } from "react";
import { LocalModelSettings } from "./LocalModelSettings.jsx";
import { Button } from "../../vendor/zcode/packages/ui/src/components/ui/button.tsx";

/** 本地宿主不提供购买能力；保留上游调用契约，但不挂载弹窗、轮询或外部网页。 */
const unavailablePlan = Object.freeze({
  inventory: { status: "ready", entryPlanList: "", retry: () => {} },
  openCodingPlanUpgrade: () => false,
});
export function CodingPlanUpgradeDialogProvider({ children }) {
  return children;
}
export function useCodingPlanUpgradeDialog() {
  return unavailablePlan;
}
export function useOptionalCodingPlanUpgradeDialog() {
  return null;
}
export function useCodingPlanEntryGate() {
  return { status: "disabled", label: undefined };
}
export function CodingPlanEntryButton() {
  return null;
}
export function ConversationQuotaBanner() {
  return null;
}
export function useTokenRefresh() {
  return { tryRefresh: async () => false, clearCredentials: async () => {} };
}

/** 清除旧的展示态，绝不读取 ZCode 凭证或订阅 OAuth 回调。 */
export function useRootOAuthEffects({
  setUser,
  setIsRestoringOAuthSession,
  setOAuthPollingActive,
  setOAuthError,
}) {
  useEffect(() => {
    setUser(null);
    setIsRestoringOAuthSession(false);
    setOAuthPollingActive(false);
    setOAuthError(null);
  }, [
    setUser,
    setIsRestoringOAuthSession,
    setOAuthPollingActive,
    setOAuthError,
  ]);
}

/** 历史登录导航（包括过期 marker）统一降级为本地模型设置，不恢复登录页。 */
export function WelcomeScreen({ onComplete }) {
  return (
    <main className="mx-auto w-full max-w-3xl overflow-auto p-8">
      <Button variant="ghost" onClick={() => onComplete("apiKey")}>
        返回工作台
      </Button>
      <LocalModelSettings />
    </main>
  );
}
