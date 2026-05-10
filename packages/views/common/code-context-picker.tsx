"use client";

import { useMemo } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Switch } from "@multica/ui/components/ui/switch";
import {
  canUseLocalPathCodeContext,
  hasValidCodeContextPath,
  isLocalPathCodeContext,
  type Agent,
  type CodeContext,
} from "@multica/core/types";

type Copy = {
  label: string;
  defaultRepo: string;
  localPath: string;
  desktopChoose: string;
  webPlaceholder: string;
  desktopHint: string;
  webHint: string;
  runtimeBlocked: string;
  invalidPath: string;
  sessionLocked?: string;
};

function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as typeof window & { desktopAPI?: unknown }).desktopAPI);
}

async function pickDesktopDirectory(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const desktopAPI = (
    window as typeof window & {
      desktopAPI?: { selectDirectory?: () => Promise<string | null> };
    }
  ).desktopAPI;
  if (!desktopAPI?.selectDirectory) return null;
  return desktopAPI.selectDirectory();
}

export function getCodeContextError(
  codeContext: CodeContext,
  agent?: Pick<Agent, "runtime_mode"> | null,
): string | null {
  if (!canUseLocalPathCodeContext(codeContext, agent?.runtime_mode)) {
    return "runtime";
  }
  if (!hasValidCodeContextPath(codeContext)) {
    return "path";
  }
  return null;
}

export function CodeContextPicker({
  value,
  onChange,
  agent,
  copy,
  disabled = false,
  locked = false,
}: {
  value: CodeContext;
  onChange: (value: CodeContext) => void;
  agent?: Pick<Agent, "runtime_mode"> | null;
  copy: Copy;
  disabled?: boolean;
  locked?: boolean;
}) {
  const isDesktop = isDesktopApp();
  const localMode = isLocalPathCodeContext(value);
  const runtimeBlocked = !canUseLocalPathCodeContext(
    { type: "local_path", path: localMode ? value.path : "/" },
    agent?.runtime_mode,
  );
  const errorType = getCodeContextError(value, agent);

  const hint = useMemo(() => {
    if (locked && copy.sessionLocked) return copy.sessionLocked;
    if (errorType === "runtime") return copy.runtimeBlocked;
    if (errorType === "path") return copy.invalidPath;
    return isDesktop ? copy.desktopHint : copy.webHint;
  }, [copy, errorType, isDesktop, locked]);

  const chooseDirectory = async () => {
    const selected = await pickDesktopDirectory();
    if (!selected) return;
    onChange({ type: "local_path", path: selected });
  };

  return (
    <div className="space-y-2 px-5 pb-2 shrink-0">
      <div className="flex items-center justify-between gap-3 rounded-md border bg-card/50 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-medium">{copy.label}</div>
          <div className="text-xs text-muted-foreground">
            {localMode ? copy.localPath : copy.defaultRepo}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{copy.defaultRepo}</span>
          <Switch
            size="sm"
            checked={localMode}
            disabled={disabled || locked}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? { type: "local_path", path: localMode ? value.path : "" }
                  : { type: "default_repo" },
              )
            }
          />
          <span>{copy.localPath}</span>
        </label>
      </div>

      {localMode && (
        <div className="space-y-2 rounded-md border bg-card/30 px-3 py-3">
          {isDesktop ? (
            <div className="flex items-center gap-2">
              <Input
                value={value.path}
                readOnly
                disabled={disabled}
                placeholder={copy.webPlaceholder}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || locked || runtimeBlocked}
                onClick={chooseDirectory}
              >
                <FolderOpen className="size-3.5" />
                {copy.desktopChoose}
              </Button>
            </div>
          ) : (
            <Input
              value={value.path}
              disabled={disabled || locked || runtimeBlocked}
              onChange={(event) =>
                onChange({ type: "local_path", path: event.target.value })
              }
              placeholder={copy.webPlaceholder}
              className="font-mono text-xs"
            />
          )}
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      )}
    </div>
  );
}
