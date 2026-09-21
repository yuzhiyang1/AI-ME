import { useEffect, useState } from "react";
import { Button } from "../../vendor/zcode/packages/ui/src/components/ui/button.tsx";
import { Input } from "../../vendor/zcode/packages/ui/src/components/ui/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../vendor/zcode/packages/ui/src/components/ui/dialog.tsx";
import * as api from "../api.ts";
import { projectKey } from "./projects.js";

/** 使用原版 Dialog/Input/Button，项目与会话仍由 AI-ME 后端负责持久化。 */
export function ProjectManager({ host, onChanged }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState([]);
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState("");
  const [roots, setRoots] = useState([""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteId, setDeleteId] = useState(null);
  const [createKey, setCreateKey] = useState(() => crypto.randomUUID());

  useEffect(
    () =>
      host.projectDialog.subscribe((value) => {
        setOpen(value);
        if (value) {
          setProjects(host.directory.list());
          setError("");
          setDeleteId(null);
          edit(null);
        }
      }),
    [host],
  );

  function edit(project) {
    setEditing(project);
    setName(project?.name ?? "");
    setRoots(project?.roots.map((root) => root.path) ?? [""]);
    setCreateKey(crypto.randomUUID());
    setError("");
  }

  async function refresh(selected) {
    // 更新目录模板不重写会话快照；删除后由后端把原会话解绑为独立会话。
    const [next, sessions] = await Promise.all([
      api.listProjects(),
      api.listSessions(),
    ]);
    host.directory.replace(next, sessions);
    setProjects(next);
    const paths = host.directory.paths();
    await host.services.settingService.update({
      recentProjects: selected
        ? [selected, ...paths.filter((p) => p !== selected)]
        : paths,
    });
    onChanged?.();
  }

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const input = {
        name: name.trim(),
        roots: roots.map((root) => root.trim()),
      };
      const project = editing
        ? await api.updateProject(editing.id, input)
        : await api.createProject(input, createKey);
      // 保存成功即切为编辑状态；刷新失败后重试不能再次新建项目。
      setEditing(project);
      await refresh(projectKey(project.id));
      host.projectDialog.close(projectKey(project.id));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(project) {
    setBusy(true);
    setError("");
    try {
      await api.deleteProject(project.id);
      setDeleteId(null);
      edit(null);
      await refresh();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) host.projectDialog.close();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>项目管理</DialogTitle>
          <DialogDescription>
            按项目组织会话。修改目录只影响新会话，已有会话保留原目录快照。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {projects.map((project) => (
            <div
              key={project.id}
              className="flex items-center gap-2 rounded-lg border border-border p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{project.name}</div>
                <div className="truncate text-xs text-foreground-subtle">
                  {project.roots.length} 个目录 · {project.roots[0]?.path}
                </div>
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => host.projectDialog.close(projectKey(project.id))}
              >
                打开
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => edit(project)}
              >
                编辑
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setDeleteId(project.id)}
              >
                删除
              </Button>
              {deleteId === project.id && (
                <div role="alert" className="space-y-2 text-xs">
                  <p>仅删除项目配置，会话和文件不会删除。</p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => remove(project)}
                  >
                    确认删除
                  </Button>
                  <Button variant="ghost" onClick={() => setDeleteId(null)}>
                    取消
                  </Button>
                </div>
              )}
            </div>
          ))}
          <Button variant="outline" disabled={busy} onClick={() => edit(null)}>
            新增项目
          </Button>
        </div>
        <form className="space-y-4 border-t border-border pt-4" onSubmit={save}>
          <h3 className="font-medium">{editing ? "编辑项目" : "新增项目"}</h3>
          <label className="block space-y-2">
            项目名称
            <Input
              aria-label="项目名称"
              maxLength={120}
              required
              disabled={busy}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="space-y-2">
            <p className="text-sm">源文件夹（第一项为主目录）</p>
            {roots.map((root, index) => (
              <div className="flex items-center gap-2" key={index}>
                <Input
                  aria-label={`目录 ${index + 1}`}
                  required
                  disabled={busy}
                  value={root}
                  onChange={(event) =>
                    setRoots((old) =>
                      old.map((item, i) =>
                        i === index ? event.target.value : item,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    try {
                      const path = await host.platform.selectDirectory();
                      if (path)
                        setRoots((old) =>
                          old.map((item, i) => (i === index ? path : item)),
                        );
                    } catch (cause) {
                      setError(cause.message);
                    }
                  }}
                >
                  选择
                </Button>
                {index > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      setRoots([root, ...roots.filter((_, i) => i !== index)])
                    }
                  >
                    设为主目录
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`移除目录 ${index + 1}`}
                  disabled={busy || roots.length === 1}
                  onClick={() => setRoots(roots.filter((_, i) => i !== index))}
                >
                  移除
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setRoots([...roots, ""])}
            >
              添加目录
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => host.projectDialog.close()}
            >
              取消
            </Button>
            <Button
              disabled={
                busy || !name.trim() || roots.some((root) => !root.trim())
              }
            >
              {busy ? "正在保存…" : "保存项目"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
