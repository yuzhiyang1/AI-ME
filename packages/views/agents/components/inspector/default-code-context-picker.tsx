"use client";

import { useState } from "react";
import { FolderOpen, GitBranch } from "lucide-react";
import {
  isLocalPathCodeContext,
  type Agent,
  type CodeContext,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import {
  PickerItem,
  PropertyPicker,
} from "../../../issues/components/pickers";
import { CHIP_CLASS } from "./chip";

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

export function DefaultCodeContextPicker({
  agent,
  canEdit = true,
  onChange,
}: {
  agent: Pick<Agent, "default_code_context" | "runtime_mode">;
  canEdit?: boolean;
  onChange: (value: CodeContext | null) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const value = agent.default_code_context ?? { type: "default_repo" };
  const localMode = isLocalPathCodeContext(value);
  const Icon = localMode ? FolderOpen : GitBranch;
  const label = localMode ? value.path : "Default repo";
  const canUseLocalPath = agent.runtime_mode === "local";
  const isDesktop = isDesktopApp();

  const setDefaultRepo = async () => {
    setOpen(false);
    await onChange(null);
  };

  const setLocalPath = async (path: string) => {
    if (!path.trim()) return;
    setOpen(false);
    await onChange({ type: "local_path", path: path.trim() });
  };

  if (!canEdit) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 px-1.5 py-0.5 text-xs text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate font-mono">{label}</span>
      </span>
    );
  }

  return (
    <PropertyPicker
      open={open}
      onOpenChange={setOpen}
      width="w-auto min-w-[22rem] max-w-lg"
      align="start"
      tooltip={localMode ? value.path : "Use the issue-selected repo by default"}
      triggerRender={
        <button type="button" className={CHIP_CLASS} aria-label="Default workspace" />
      }
      trigger={
        <>
          <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono">{label}</span>
        </>
      }
    >
      <PickerItem selected={!localMode} onClick={() => void setDefaultRepo()}>
        <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">Default repo</div>
          <div className="truncate text-xs text-muted-foreground">
            Use the workspace repo selected on the issue.
          </div>
        </div>
      </PickerItem>
      <div className="px-2 py-2">
        <LocalPathEditor
          value={localMode ? value.path : ""}
          disabled={!canUseLocalPath}
          isDesktop={isDesktop}
          onSubmit={setLocalPath}
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          {canUseLocalPath
            ? "Issues assigned to this agent inherit this directory when no issue workspace is selected."
            : "Local directory defaults require a local runtime."}
        </p>
      </div>
    </PropertyPicker>
  );
}

function LocalPathEditor({
  value,
  disabled,
  isDesktop,
  onSubmit,
}: {
  value: string;
  disabled: boolean;
  isDesktop: boolean;
  onSubmit: (path: string) => Promise<void> | void;
}) {
  const [path, setPath] = useState(value);

  const chooseDirectory = async () => {
    const selected = await pickDesktopDirectory();
    if (!selected) return;
    setPath(selected);
    await onSubmit(selected);
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        value={path}
        readOnly={isDesktop}
        disabled={disabled}
        onChange={(event) => setPath(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void onSubmit(path);
        }}
        placeholder="D:\\program\\code\\workSpace\\Lottery-master"
        className="font-mono text-xs"
      />
      {isDesktop ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void chooseDirectory()}
        >
          <FolderOpen className="size-3.5" />
          Choose
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !path.trim()}
          onClick={() => void onSubmit(path)}
        >
          Save
        </Button>
      )}
    </div>
  );
}
