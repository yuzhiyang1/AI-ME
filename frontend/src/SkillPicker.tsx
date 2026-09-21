/** 沿用项目设置弹窗：目录只用于用户选择，不把完整库存发送给模型。 */
import { useEffect, useState } from "react";
import { BookOpen, X } from "lucide-react";
import { listSkills, saveSkillPreference, type SkillEntry } from "./api";

export function SkillPicker(props: {sessionId?: string; disabled: boolean; library?: boolean; onSelect: (ref: string) => void}) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    setError("");
    void listSkills(props.sessionId).then(result => {
      if (!cancelled) { setSkills(result.skills); setDiagnostics(result.diagnostics); }
    }).catch(reason => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [open, props.sessionId, revision]);

  // 搜索和刷新后回到首页，避免旧页码让已有结果看起来像空列表。
  useEffect(() => { setPage(0); }, [query, revision, props.sessionId]);

  async function update(skill: SkillEntry) {
    setBusy(true);
    setError("");
    try {
      await saveSkillPreference(props.sessionId, skill);
      setSkills(current => current.map(item => item.ref === skill.ref ? skill : item));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  const matches = skills.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase()
    .includes(query.toLocaleLowerCase()));
  return <>
    <button className={props.library ? "settings-row" : "skill-picker-trigger"} type="button" onClick={() => setOpen(true)}>
      <BookOpen size={14} /> {props.library ? "Skill 列表" : "Skill"}
    </button>
    {open ? <div className="dialog-backdrop" role="presentation">
      <section className="project-dialog skill-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-title">
        <header><h2 id="skill-title">{props.library ? "Skill 列表" : "选择 Skill"}</h2><button type="button" aria-label="关闭 Skill" onClick={() => setOpen(false)}><X size={16} /></button></header>
        <label className="project-name-field"><span>搜索名称或用途</span><div><BookOpen size={15}/><input autoFocus value={query} onChange={event => setQuery(event.target.value)} /></div></label>
        <p className="skill-help">{props.sessionId ? "当前会话的项目与个人 Skill" : "个人 Skill · 进入会话后还可查看项目 Skill"}。共 {skills.length} 个，已启用 {skills.filter(skill => skill.enabled).length} 个。</p>
        <div className="skill-list-toolbar"><span>{matches.length} 个匹配结果</span><button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>刷新列表</button></div>
        {error ? <p role="alert" className="inline-error">{error}</p> : null}
        {busy ? <p role="status">正在读取或保存…</p> : null}
        <div className="skill-list">{matches.slice(page * 20, (page + 1) * 20).map(skill => <article className="skill-row" key={skill.ref}>
          <div><strong>{skill.name}</strong><small className="skill-state">{skill.enabled ? "已启用" : "已停用"}</small><p>{skill.description}</p><small>{skill.explicit_only ? "仅手动选择 · " : ""}{skill.shadowed ? "同名备用来源 · " : ""}{skill.ref}</small></div>
          <div className="skill-actions"><label><input type="checkbox" checked={skill.enabled} disabled={busy} onChange={event => void update({...skill, enabled: event.target.checked})}/>启用</label>
          <label><input type="checkbox" checked={skill.pinned} disabled={busy} onChange={event => void update({...skill, pinned: event.target.checked})}/>固定</label>
          <button type="button" disabled={busy || !skill.enabled || props.disabled || !props.sessionId} onClick={() => {props.onSelect(skill.ref); setOpen(false);}}>{props.sessionId ? "使用" : "请先进入会话"}</button></div>
        </article>)}</div>
        {matches.length > 20 ? <div className="skill-list-toolbar"><button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {page + 1} / {Math.ceil(matches.length / 20)} 页</span><button type="button" disabled={(page + 1) * 20 >= matches.length} onClick={() => setPage(value => value + 1)}>下一页</button></div> : null}
        {!busy && !error && !matches.length ? <p>{query ? "没有匹配项，请换个关键词。" : "还没有 Skill。将 Skill 文件夹放到个人 ~/.agents/skills 或项目 .agents/skills 后刷新列表。"}</p> : null}
        {diagnostics.length ? <details><summary>{diagnostics.length} 条发现诊断</summary>{diagnostics.map((item, index) => <p key={index}>{item}</p>)}</details> : null}
      </section>
    </div> : null}
  </>;
}
