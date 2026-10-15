'use client';
import { useEffect, useState } from 'react';
import { PronunciationRuleSchema, type PronunciationRule } from '@m2v/schema';

export function PronunciationEditor({ selection, sceneRules, projectRules, disabled, onSceneRules, onProjectRules, onGlobalChange }: {
  selection: { text: string; occurrence: number } | null;
  sceneRules: PronunciationRule[]; projectRules: PronunciationRule[]; disabled: boolean;
  onSceneRules: (rules: PronunciationRule[]) => void;
  onProjectRules: (rules: PronunciationRule[]) => void;
  onGlobalChange: (texts: string[]) => void;
}) {
  const [text, setText] = useState('');
  const [sounds, setSounds] = useState('');
  const [scope, setScope] = useState('scene');
  const [globalRules, setGlobalRules] = useState<PronunciationRule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { if (selection) { setText(selection.text); setScope('occurrence'); } }, [selection]);
  useEffect(() => {
    let alive = true;
    void fetch('/api/settings/pronunciation').then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (alive) { setGlobalRules(result.rules); setLoaded(true); }
    }).catch(error => { if (alive) setMessage(error.message); });
    return () => { alive = false; };
  }, []);
  async function saveGlobal(rules: PronunciationRule[]) {
    setBusy(true);
    try {
      const response = await fetch('/api/settings/pronunciation', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rules) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      onGlobalChange([...new Set([...rules, ...globalRules].map(rule => rule.text))]);
      setGlobalRules(result.rules);
      setMessage('通用规则已保存；重新生成受影响场景的语音后生效。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  }
  function add() {
    try {
      const rule = PronunciationRuleSchema.parse({ text: text.trim(), pinyin: sounds.trim().toLowerCase().split(/\s+/), ...(scope === 'occurrence' ? { occurrence: selection?.occurrence } : {}) });
      if (scope === 'occurrence' && (!selection || rule.text !== selection.text)) throw new Error('请先在旁白中选中要纠音的汉字');
      const rules = scope === 'global' ? globalRules : scope === 'project' ? projectRules : sceneRules;
      const next = [...rules.filter(item => item.text !== rule.text || item.occurrence !== rule.occurrence), rule];
      if (scope === 'global') { void saveGlobal(next); return; }
      if (scope === 'project') onProjectRules(next); else onSceneRules(next);
      setMessage('纠音已添加。保存分镜或生成此场景语音时会一起保存。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '读音格式错误'); }
  }
  return <details className="settings-card"><summary>中文读音纠正</summary>
    <p className="hint">自动结合完整旁白判断多音字。也可选中旁白中的汉字，指定这一处读音。</p>
    <label className="field-label">汉字或词组</label><input aria-label="纠音词组" className="input" disabled={disabled || busy} value={text} onChange={event => setText(event.target.value)} placeholder="几行代码" />
    <label className="field-label">拼音（每字一个，声调用 1–5）</label><input aria-label="指定拼音" className="input" disabled={disabled || busy} value={sounds} onChange={event => setSounds(event.target.value)} placeholder="ji3 hang2 dai4 ma3" />
    <label className="field-label">生效范围</label><select aria-label="纠音范围" className="input" disabled={disabled || busy} value={scope} onChange={event => setScope(event.target.value)}>
      <option value="occurrence" disabled={!selection}>仅选中位置{selection ? `（第 ${selection.occurrence} 处）` : ''}</option><option value="scene">当前场景同词组</option><option value="project">当前项目同词组</option><option value="global" disabled={!loaded}>所有项目同词组</option>
    </select>
    <button className="button subtle" disabled={disabled || busy || (scope === 'global' && !loaded)} onClick={add}>保存读音规则</button>
    <p className="hint">修改旁白后，位置标注会清除。优先使用位置标注，其次为场景、项目和通用规则。</p>
    {message && <p role="status" className="hint">{message}</p>}
    {([{ label: '当前场景', rules: sceneRules, update: onSceneRules }, { label: '当前项目', rules: projectRules, update: onProjectRules }, { label: '所有项目', rules: globalRules, update: (rules: PronunciationRule[]) => { void saveGlobal(rules); } }]).map(group => <div key={group.label}>{group.rules.map((rule, index) => <p key={`${rule.text}-${rule.occurrence ?? 0}`} className="hint"><b>{group.label} · {rule.text}{rule.occurrence ? `（第 ${rule.occurrence} 处）` : ''}</b><br />{rule.pinyin.join(' ')} <button className="text-button" disabled={disabled || busy} onClick={() => group.update(group.rules.filter((_, i) => i !== index))}>删除</button></p>)}</div>)}
  </details>;
}
