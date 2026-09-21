import { CircleAlert, Folder, FolderPlus, GripVertical, Star, X } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";

import type { Project, SaveProjectInput } from "./api";

type ProjectDialogProps = {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  onChooseFolder: () => Promise<string | null>;
  onSave: (input: SaveProjectInput) => Promise<void>;
};

/** 编辑项目的完整 roots 数组；第一项即主目录，保存失败时不丢用户输入。 */
export function ProjectDialog(props: ProjectDialogProps) {
  const [name, setName] = useState("");
  const [roots, setRoots] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setName(props.project?.name ?? "");
    setRoots(props.project?.roots.map((root) => root.path) ?? []);
    setError(null);
  }, [props.open, props.project]);

  if (!props.open) return null;

  async function addFolder() {
    const selected = await props.onChooseFolder();
    if (!selected) return;
    const key = normalizePathKey(selected);
    if (roots.some((root) => normalizePathKey(root) === key)) {
      setError("项目中不能添加重复目录");
      return;
    }
    setRoots((current) => [...current, selected]);
    setError(null);
  }

  function makePrimary(index: number) {
    setRoots((current) => [current[index], ...current.filter((_, item) => item !== index)]);
  }

  function removeRoot(index: number) {
    if (roots.length <= 1) return;
    setRoots((current) => current.filter((_, item) => item !== index));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || roots.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      await props.onSave({ name: name.trim(), roots });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
        <header>
          <h2 id="project-dialog-title">{props.project ? "编辑项目" : "新增项目"}</h2>
          <button type="button" aria-label="关闭项目设置" onClick={props.onClose}><X size={16} /></button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label className="project-name-field">
            <span>项目名称</span>
            <div><Folder size={15} /><input aria-label="项目名称" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 AI-ME" /></div>
          </label>
          <div className="project-roots-heading"><span>源文件夹</span><small>第一个目录是主目录</small></div>
          <div className="project-root-list">
            {roots.map((root, index) => (
              <div className="project-root-row" key={normalizePathKey(root)}>
                <GripVertical size={13} />
                <Folder size={14} />
                <span title={root}>{folderName(root)}</span>
                {index === 0 ? <em>主要</em> : (
                  <button type="button" aria-label={`将 ${folderName(root)} 设为主要`} onClick={() => makePrimary(index)}>
                    <Star size={12} /> 设为主要
                  </button>
                )}
                <button
                  className="remove-root"
                  type="button"
                  aria-label={`移除 ${folderName(root)}`}
                  disabled={roots.length <= 1 || index === 0}
                  onClick={() => removeRoot(index)}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <button className="add-project-root" type="button" onClick={() => void addFolder()}>
              <FolderPlus size={15} /> 添加文件夹
            </button>
          </div>
          {error ? <p className="project-dialog-error"><CircleAlert size={13} />{error}</p> : null}
          <footer>
            <button type="button" onClick={props.onClose}>取消</button>
            <button className="primary" type="submit" disabled={!name.trim() || roots.length === 0 || saving}>
              {saving ? "正在保存…" : "保存项目"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function normalizePathKey(path: string) {
  return path.replaceAll("/", "\\").replace(/\\+$/, "").toLocaleLowerCase();
}

function folderName(path: string) {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}
