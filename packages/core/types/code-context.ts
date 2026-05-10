export type CodeContext =
  | { type: "default_repo" }
  | { type: "local_path"; path: string };

export function defaultCodeContext(): CodeContext {
  return { type: "default_repo" };
}

export function isLocalPathCodeContext(
  value: CodeContext,
): value is Extract<CodeContext, { type: "local_path" }> {
  return value.type === "local_path";
}

export function isAbsoluteCodeContextPath(path: string): boolean {
  return /^\/|^[A-Za-z]:[\\/]|^\\\\/.test(path.trim());
}

export function canUseLocalPathCodeContext(
  value: CodeContext,
  runtimeMode?: "local" | "cloud",
): boolean {
  return !isLocalPathCodeContext(value) || runtimeMode === "local";
}

export function hasValidCodeContextPath(value: CodeContext): boolean {
  return !isLocalPathCodeContext(value) || isAbsoluteCodeContextPath(value.path);
}
