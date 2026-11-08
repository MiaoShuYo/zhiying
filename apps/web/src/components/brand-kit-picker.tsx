import type { BrandKit, BrandSnapshot } from '@m2v/schema';
import {
  BRAND_CHANGE_KEEPS,
  BRAND_CHANGE_UPDATES,
  brandChangeHeading,
} from '@/lib/brand-kit-ui';
import { BrandKitOption, PaletteSwatches } from './brand-kit-preview';

/**
 * 项目编辑器的品牌区域（纯展示组件）。
 *
 * 品牌属于项目级设置：显示当前快照品牌、来源套件是否已删除，以及更换 / 重新应用 /
 * 移除入口。切换确认明确列出“将更新 / 不会修改”，让用户知道旁白、配音、字幕时间
 * 和场景时长都不会被重新生成。
 */

export function ProjectBrandBar({
  brandName, brandColors, stale, disabled, working, error, notice,
  onOpenPicker, onReapply, onRemove,
}: {
  brandName: string | null;
  brandColors?: BrandSnapshot['colors'];
  stale: boolean;
  disabled: boolean;
  working: boolean;
  error: string;
  notice: string;
  onOpenPicker: () => void;
  onReapply: () => void;
  onRemove: () => void;
}) {
  return <section className="brand-project-bar" aria-label="项目品牌套件">
    <span className="brand-project-name">
      {brandName
        ? <>品牌：<b>{brandName}</b>{stale ? <em className="brand-project-stale">（来源套件已删除）</em> : null}</>
        : <>品牌：<b>未应用</b></>}
    </span>
    {brandColors ? <PaletteSwatches colors={brandColors} label="当前项目品牌色板" /> : null}
    <span className="brand-project-actions">
      <button className="button subtle" disabled={disabled} onClick={onOpenPicker}>{brandName ? '更换' : '选择品牌'}</button>
      {brandName && !stale && <button className="button subtle" disabled={disabled} onClick={onReapply}>{working ? '应用中…' : '重新应用'}</button>}
      {brandName && <button className="text-button" disabled={disabled} onClick={onRemove}>移除</button>}
    </span>
    {disabled && !working && <p className="brand-project-hint">项目正在执行任务或保存中，品牌切换暂不可用。</p>}
    {stale && <p className="brand-project-hint">来源品牌套件已从品牌库删除；项目仍使用保存时的品牌快照，可更换为其它品牌或移除。</p>}
    {error && <p className="brand-project-error" role="alert">{error}</p>}
    {notice && !error && <p className="brand-project-hint" role="status">{notice}</p>}
  </section>;
}

/** Picker shown after “更换 / 选择品牌”: Logo、名称、简化色板、基础 Style 与默认标记。 */
export function BrandKitPicker({
  kits, currentKitId, loading, disabled, error, onSelect, onClose,
}: {
  kits: BrandKit[];
  currentKitId?: string;
  loading: boolean;
  disabled: boolean;
  error: string;
  onSelect: (kit: BrandKit) => void;
  onClose: () => void;
}) {
  return <div className="modal-backdrop" role="presentation">
    <section className="modal manage-modal brand-picker-modal" role="dialog" aria-modal="true" aria-labelledby="brand-picker-title">
      <button className="modal-close" aria-label="关闭品牌选择器" disabled={disabled} onClick={onClose}>×</button>
      <p className="eyebrow">BRAND KIT</p>
      <h2 id="brand-picker-title">选择品牌套件</h2>
      <p className="muted">品牌只影响颜色、字体与 Logo；不会重新生成旁白、语音或分镜。</p>
      {error && <p className="error-box" role="alert">{error}</p>}
      {loading
        ? <p className="hint">正在读取品牌套件…</p>
        : kits.length
          ? <div className="brand-picker-list">{kits.map(kit => <BrandKitOption
            key={kit.id}
            kit={kit}
            selected={kit.id === currentKitId}
            disabled={disabled}
            onSelect={onSelect}
          />)}</div>
          : error ? null : <p className="hint">还没有品牌套件。先到“设置 → 品牌套件”创建一套品牌，再回来应用。</p>}
      <div className="manage-actions">
        <button className="button subtle" disabled={disabled} onClick={onClose}>取消</button>
      </div>
    </section>
  </div>;
}

/** Confirmation before a brand switch/remove: explicit update and no-change lists. */
export function BrandKitChangeDialog({
  kind, kitName, working, error, onConfirm, onCancel,
}: {
  kind: 'apply' | 'remove';
  kitName?: string;
  working: boolean;
  error: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const apply = kind === 'apply';
  return <div className="modal-backdrop">
    <section className="modal manage-modal brand-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="brand-change-title">
      <p className="eyebrow">BRAND KIT</p>
      <h2 id="brand-change-title">{apply ? `切换品牌套件${kitName ? `：${kitName}` : ''}` : '移除项目品牌套件'}</h2>
      <p className="muted">{apply
        ? '确认后会立即用品牌库里的最新内容刷新项目快照，预览随之更新。'
        : '移除后项目会回到自身 Style 的颜色与字体，项目 Logo 一并移除；之后仍可重新选择品牌。'}</p>
      <div className="brand-confirm-cols">
        <div>
          <h4>{brandChangeHeading(kind)}</h4>
          <ul className="brand-confirm-updates">
            {BRAND_CHANGE_UPDATES.map(item => <li key={item}>✓ {item}</li>)}
          </ul>
        </div>
        <div>
          <h4>不会修改</h4>
          <ul className="brand-confirm-keeps">
            {BRAND_CHANGE_KEEPS.map(item => <li key={item}>{item}</li>)}
          </ul>
        </div>
      </div>
      <p className="brand-confirm-note">品牌变更只属于视觉变更：不会调用 Qwen、重新生成 TTS、清空音频缓存或改动字幕时间。</p>
      {error && <p className="error-box" role="alert">{error}</p>}
      <div className="manage-actions">
        <button className="button subtle" disabled={working} onClick={onCancel}>取消</button>
        <button className="button primary" disabled={working} onClick={onConfirm}>{working ? '处理中…' : apply ? '确认切换' : '确认移除'}</button>
      </div>
    </section>
  </div>;
}
