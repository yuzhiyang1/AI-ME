/** 宿主可为逻辑工作区提供项目名；缺省仍使用上游目录名。 */
let resolver: ((key: string) => string | undefined) | undefined;
export function setHostWorkspaceLabelResolver(resolve: (key: string) => string | undefined) {
  resolver = resolve;
}
export function hostWorkspaceLabel(key: string): string | undefined {
  return resolver?.(key);
}
