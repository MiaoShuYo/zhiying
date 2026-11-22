'use client';

import { FrameCardSchema, type FrameCard, type Storyboard } from '@m2v/schema';

type Props = { board: Storyboard; disabled?: boolean; onChange: (patch: Partial<Storyboard>) => void };

function withCard(card: FrameCard | undefined, patch: Partial<FrameCard>): FrameCard {
  const merged = { ...(card ?? {}), ...patch };
  return FrameCardSchema.parse({ ...merged, duration: Number.isFinite(merged.duration) ? merged.duration : 3 });
}

const cards = [
  { key: 'intro', label: '片头', hint: '开场标题卡，出现在第一个场景之前' },
  { key: 'outro', label: '片尾', hint: '收尾标题卡，出现在最后一个场景之后' },
] as const;

export function FrameSettings({ board, disabled, onChange }: Props) {
  return <section className="settings-card">
    <p className="eyebrow">FRAME</p>
    <h2>片头、片尾与转场</h2>
    {cards.map(({ key, label, hint }) => {
      const card = board[key];
      const apply = (next: FrameCard) => onChange(key === 'intro' ? { intro: next } : { outro: next });
      return <div key={key}>
        <label><input type="checkbox" disabled={disabled} checked={card?.enabled ?? false} onChange={e => apply(withCard(card, { enabled: e.currentTarget.checked }))} /> 启用{label}</label>
        <p className="muted">{hint}</p>
        {card?.enabled && <>
          <label className="field-label">{label}标题</label>
          <input className="input" maxLength={50} disabled={disabled} value={card.title ?? ''} placeholder={key === 'intro' ? board.title : '感谢观看'} onChange={e => apply(withCard(card, { title: e.currentTarget.value }))} />
          <label className="field-label">{label}副标题</label>
          <input className="input" maxLength={120} disabled={disabled} value={card.subtitle ?? ''} placeholder="可选，一行文字" onChange={e => apply(withCard(card, { subtitle: e.currentTarget.value }))} />
          <label className="field-label">{label}时长（秒）</label>
          <input className="input" type="number" min={1} max={15} step={0.5} disabled={disabled} value={card.duration} onChange={e => apply(withCard(card, { duration: Number(e.currentTarget.value) }))} />
        </>}
      </div>;
    })}
    <label className="field-label">场景转场</label>
    <select className="input" disabled={disabled} value={board.transition ?? 'none'} onChange={e => onChange({ transition: e.currentTarget.value as Storyboard['transition'] })}>
      <option value="none">无（直接切换）</option>
      <option value="cut">直切</option>
      <option value="fade">淡入淡出</option>
      <option value="crossfade">交叉淡化</option>
      <option value="wipe">擦除</option>
      <option value="slide">滑动</option>
      <option value="match-move">匹配移动</option>
      <option value="shared-element-lite">共享元素（轻量）</option>
    </select>
    {['crossfade', 'wipe', 'slide', 'match-move', 'shared-element-lite'].includes(board.transition ?? '') && <>
      <label className="field-label">转场时长（秒）</label>
      <input className="input" type="number" min={0.1} max={2.5} step={0.1} disabled={disabled} value={board.transitionDuration ?? 0.5} onChange={e => onChange({ transitionDuration: Number(e.currentTarget.value) })} />
      <p className="muted">视觉转场复用场景交界处的帧，不增加成片时长或改变旁白时间；减弱运动时，擦除和滑动会回退为淡化。</p>
    </>}
    <p className="muted">片头片尾计入成片总时长，字幕时间轴与导出前检查会自动顺延。</p>
  </section>;
}
