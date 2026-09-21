/** 独立技能页面：浏览已安装手册与真实来源，不把目录渲染成聊天弹窗。 */
import { useEffect, useState } from "react";
import { ArrowLeft, Check, Layers, Search } from "lucide-react";
import { listSkills, saveSkillPreference, type SkillEntry } from "./api";

export function SkillLibrary(props: {
  sessionId?: string;
  disabled: boolean;
  onClose: () => void;
  onSelect: (ref: string) => void;
}) {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("全部");
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(12);
  const [selected, setSelected] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void listSkills(props.sessionId).then(result => {
      if (cancelled) return;
      setSkills(result.skills);
      setDiagnostics(result.diagnostics);
      setSource("全部");
      setLimit(12);
    }).catch(reason => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.sessionId, revision]);

  async function update(skill: SkillEntry) {
    setSaving(true);
    setError("");
    try {
      await saveSkillPreference(props.sessionId, skill);
      setSkills(current => current.map(item => item.ref === skill.ref ? skill : item));
    } catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  }

  const matches = skills.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase()));
  const sources = ["全部", ...new Set(skills.map(skill => skill.source ?? "个人"))];
  const filtered = matches.filter(skill => source === "全部" || (skill.source ?? "个人") === source);
  const detail = skills.find(skill => skill.ref === selected);

  function cards(items: SkillEntry[]) {
    return <div className="skills-grid">{items.map(skill => <button type="button"
      key={skill.ref} className={`skills-tile${selected === skill.ref ? " is-selected" : ""}`}
      onClick={() => setSelected(current => current === skill.ref ? null : skill.ref)}>
      <span className="skills-icon"><Layers size={21}/></span>
      <span className="skills-tile-text"><strong>{skill.name}</strong><span title={skill.description}>{skill.description}</span></span>
      {skill.enabled ? <Check size={16} className="skills-check" aria-label="已启用"/> : <small>已停用</small>}
    </button>)}</div>;
  }

  return <section className="skills-page" aria-label="技能">
    <div className="skills-page-inner">
      <div className="skills-page-navigation"><button type="button" onClick={props.onClose}><ArrowLeft size={14}/>返回会话</button><button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>刷新</button></div>
      <header><h1>技能</h1><p>通过任务专用技能扩展 AI-ME</p></header>
      <label className="skills-search"><Search size={16}/><input aria-label="搜索技能" placeholder="搜索技能" value={query} onChange={event => {setQuery(event.target.value); setLimit(12);}}/></label>
      {error ? <p role="alert" className="skills-error">{error}</p> : null}
      {loading ? <p role="status">正在读取技能…</p> : <>
        <section aria-label="已安装"><h2>已安装 <small>{matches.length}</small></h2>
          {cards(matches.slice(0, expanded ? matches.length : 6))}
          {matches.length > 6 ? <button className="skills-more" type="button" onClick={() => setExpanded(value => !value)}>{expanded ? "收起列表" : `查看全部，另有 ${matches.length - 6} 项`}</button> : null}
          {!matches.length ? <p className="skills-empty">{query ? "没有匹配的技能，试试其他关键词。" : "暂无已安装技能。将 Skill 文件夹放入个人 ~/.agents/skills 或项目 .agents/skills 后刷新。"}</p> : null}
        </section>
        {skills.length ? <section className="skills-sources" aria-label="按来源浏览">
          <div className="skills-tabs" role="tablist" aria-label="技能来源">{sources.map(item => <button key={item} type="button" role="tab" aria-selected={source === item} onClick={() => {setSource(item); setLimit(12);}}>{item}</button>)}</div>
          {cards(filtered.slice(0, limit))}
          {!filtered.length ? <p className="skills-empty">该来源没有匹配的技能。</p> : null}
          {filtered.length > limit ? <button className="skills-more" type="button" onClick={() => setLimit(value => value + 24)}>查看更多，另有 {filtered.length - limit} 项</button> : null}
        </section> : null}
      </>}
      {detail ? <section className="skills-detail" aria-label="技能详情">
        <header><h2>{detail.name}</h2><button type="button" onClick={() => setSelected(null)}>收起详情</button></header>
        <p>{detail.description}</p><small>来源：{detail.source ?? "个人"}{detail.explicit_only ? " · 仅手动选择" : ""}{detail.shadowed ? " · 同名备用来源" : ""}</small>
        <div className="skills-detail-actions">
          <label><input type="checkbox" checked={detail.enabled} disabled={saving} onChange={event => void update({...detail, enabled: event.target.checked})}/>启用</label>
          <label><input type="checkbox" checked={detail.pinned} disabled={saving} onChange={event => void update({...detail, pinned: event.target.checked})}/>固定</label>
          <button type="button" disabled={!props.sessionId || props.disabled || !detail.enabled || saving} onClick={() => props.onSelect(detail.ref)}>{props.sessionId ? "在当前会话使用" : "请先进入会话"}</button>
        </div>
      </section> : null}
      {diagnostics.length ? <details className="skills-diagnostics"><summary>{diagnostics.length} 条读取提示</summary>{diagnostics.map((text, index) => <p key={index}>{text}</p>)}</details> : null}
    </div>
  </section>;
}
