import type { BrandKit, StyleId } from '@m2v/schema';
import {
  BRAND_KIT_DELETE_NOTE,
  LOGO_MARGIN_RANGE,
  LOGO_POSITIONS,
  LOGO_WIDTH_RANGE,
  MAX_BRAND_KIT_NAME,
  PALETTE_KEYS,
  STYLE_IDS,
  brandKitLimitMessage,
  brandKitStyleName,
  draftIssueFor,
  logoPositionLabels,
  normalizeHex,
  paletteLabels,
  publicAssetUrl,
  type BrandKitDraft,
  type BrandKitDraftIssue,
  type LogoPosition,
} from '@/lib/brand-kit-ui';
import { BrandKitCard, BrandKitPreview } from './brand-kit-preview';

/**
 * 品牌套件设置页的静态展示层。
 *
 * 列表、表单与删除确认都是纯 props 组件（无 hooks / 无 fetch），交互状态由外层
 * `BrandKits` 控制；这样可以在无 jsdom 的测试环境里 renderToStaticMarkup 出
 * 空列表、上限提示、非法 hex 和删除确认文案。
 */

export function BrandKitList({
  kits, max, loading, working, error, notice,
  onStartCreate, onEdit, onDuplicate, onSetDefault, onDelete,
}: {
  kits: BrandKit[];
  max: number;
  loading: boolean;
  working: boolean;
  error: string;
  notice: string;
  onStartCreate: () => void;
  onEdit: (kit: BrandKit) => void;
  onDuplicate: (kit: BrandKit) => void;
  onSetDefault: (kit: BrandKit) => void;
  onDelete: (kit: BrandKit) => void;
}) {
  const atLimit = kits.length >= max;
  return <>
    <div className="brand-kit-head">
      <div>
        <p className="eyebrow">BRAND KIT LIBRARY</p>
        <h2>品牌套件</h2>
        <p className="muted">品牌套件只定义品牌颜色、字体与 Logo，和声音、字幕、BGM、导出等制作方案分开管理。修改品牌库不会自动改变已应用该品牌的项目。</p>
      </div>
      <button className="button primary" disabled={loading || working || atLimit} onClick={onStartCreate}>＋ 新建品牌套件</button>
    </div>
    <p className="hint">项目使用创建或切换时的品牌快照；想用上品牌库的最新修改，需要在项目编辑器里点“重新应用”。最多保存 {max} 个品牌套件。</p>
    {atLimit && <p className="brand-kit-note" role="status">{brandKitLimitMessage(max)}</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p className="settings-success" role="status">{notice}</p>}
    {loading
      ? <p className="hint">正在读取品牌套件…</p>
      : kits.length
        ? <div className="brand-kit-grid">{kits.map(kit => <BrandKitCard
          key={kit.id}
          kit={kit}
          disabled={working}
          onEdit={onEdit}
          onDuplicate={onDuplicate}
          onSetDefault={onSetDefault}
          onDelete={onDelete}
        />)}</div>
        : <div className="brand-kit-empty">
          <p className="eyebrow">EMPTY LIBRARY</p>
          <h3>还没有品牌套件</h3>
          <p className="muted">创建一套品牌，把颜色、字体和 Logo 复用到多个项目。品牌与声音、字幕等制作方案分开管理。</p>
          <button className="button primary" disabled={working || atLimit} onClick={onStartCreate}>＋ 新建品牌套件</button>
        </div>}
  </>;
}

function DraftFieldError({ issues, field }: { issues: BrandKitDraftIssue[]; field: string }) {
  const issue = draftIssueFor(issues, field);
  return issue ? <p className="brand-field-error" role="alert">{issue.message}</p> : null;
}

export function BrandKitForm({
  draft, issues, editingId, working, uploadingLogo, error, notice, pendingLogoName,
  onChange, onLogoFile, onSave, onCancel,
}: {
  draft: BrandKitDraft;
  issues: BrandKitDraftIssue[];
  editingId: string | null;
  working: boolean;
  uploadingLogo: boolean;
  error: string;
  notice: string;
  pendingLogoName: string;
  onChange: (next: BrandKitDraft) => void;
  onLogoFile: (file: File | null) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const logoSource = draft.logo.src ? '已上传 Logo' : pendingLogoName ? `待上传：${pendingLogoName}` : '尚未上传 Logo';
  const noLogoHint = !draft.logo.src && !pendingLogoName;
  return <div className="brand-kit-form">
    <div className="brand-kit-fields">
      <div className="brand-kit-head">
        <div>
          <p className="eyebrow">{editingId ? 'EDIT BRAND KIT' : 'NEW BRAND KIT'}</p>
          <h2>{editingId ? '编辑品牌套件' : '新建品牌套件'}</h2>
          <p className="muted">品牌套件只定义颜色、字体与 Logo；不会修改声音、字幕、BGM 或导出设置。</p>
        </div>
      </div>

      <label className="field-label" htmlFor="brand-kit-name">名称</label>
      <input
        id="brand-kit-name"
        className="input"
        maxLength={MAX_BRAND_KIT_NAME}
        placeholder="例如：ACME Corporate"
        value={draft.name}
        disabled={working}
        aria-invalid={Boolean(draftIssueFor(issues, 'name'))}
        onChange={event => onChange({ ...draft, name: event.target.value })}
      />
      <DraftFieldError issues={issues} field="name" />

      <label className="field-label" htmlFor="brand-kit-style">基础 Style</label>
      <select
        id="brand-kit-style"
        className="input"
        value={draft.baseStyleId}
        disabled={working}
        onChange={event => onChange({ ...draft, baseStyleId: event.target.value as StyleId })}
      >
        {STYLE_IDS.map(id => <option key={id} value={id}>{brandKitStyleName(id)}</option>)}
      </select>
      <p className="hint">基础 Style 决定版式与动画节奏；品牌颜色、字体与 Logo 叠加在其上。</p>

      <p className="brand-kit-section-title">品牌颜色</p>
      <p className="hint">直接编辑 renderer 的六个调色板字段，每项都可以用取色器或输入 #RRGGBB；非法值会即时提示且不会提交。</p>
      {PALETTE_KEYS.map(key => <div className="brand-color-row" key={key}>
        <span className="brand-color-label">{paletteLabels[key]}</span>
        <input
          type="color"
          aria-label={`${paletteLabels[key]}取色器`}
          value={normalizeHex(draft.colors[key]) ?? '#000000'}
          disabled={working}
          onChange={event => onChange({ ...draft, colors: { ...draft.colors, [key]: event.target.value } })}
        />
        <input
          className="input"
          aria-label={`${paletteLabels[key]}十六进制`}
          spellCheck={false}
          maxLength={7}
          value={draft.colors[key]}
          disabled={working}
          aria-invalid={!normalizeHex(draft.colors[key])}
          onChange={event => onChange({ ...draft, colors: { ...draft.colors, [key]: event.target.value } })}
        />
        <DraftFieldError issues={issues} field={`colors.${key}`} />
      </div>)}

      <p className="brand-kit-section-title">字体</p>
      <div className="brand-kit-two">
        <div>
          <label className="field-label" htmlFor="brand-kit-heading-font">标题字体</label>
          <input
            id="brand-kit-heading-font"
            className="input"
            maxLength={100}
            placeholder="例如：Arial / Georgia"
            value={draft.typography.headingFont}
            disabled={working}
            onChange={event => onChange({ ...draft, typography: { ...draft.typography, headingFont: event.target.value } })}
          />
          <DraftFieldError issues={issues} field="typography.headingFont" />
        </div>
        <div>
          <label className="field-label" htmlFor="brand-kit-body-font">正文字体</label>
          <input
            id="brand-kit-body-font"
            className="input"
            maxLength={100}
            placeholder="例如：Noto Sans"
            value={draft.typography.bodyFont}
            disabled={working}
            onChange={event => onChange({ ...draft, typography: { ...draft.typography, bodyFont: event.target.value } })}
          />
          <DraftFieldError issues={issues} field="typography.bodyFont" />
        </div>
      </div>
      <p className="hint">MVP 只填写本机已安装的字体名，不上传字体文件、不联网下载字体。</p>

      <p className="brand-kit-section-title">Logo</p>
      <label className="button subtle brand-logo-upload">
        {uploadingLogo ? '正在上传 Logo…' : draft.logo.src ? '替换 Logo' : '上传 Logo'}
        <input
          className="brand-logo-file"
          type="file"
          accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
          disabled={working || uploadingLogo}
          onChange={event => {
            const file = event.currentTarget.files?.[0] ?? null;
            event.currentTarget.value = '';
            onLogoFile(file);
          }}
        />
      </label>
      <div className="brand-logo-preview">
        <span className="brand-kit-logo">{draft.logo.src ? <img src={publicAssetUrl(draft.logo.src)} alt="当前品牌 Logo" /> : <span>无</span>}</span>
        <span>{logoSource}</span>
        <span className="hint">{editingId ? 'Logo 上传后会立即写入品牌库，其它字段仍需点保存。' : '选择 Logo 后会随新品牌套件一起上传。'}</span>
      </div>
      <div className="brand-logo-controls">
        <label><input
          type="checkbox"
          checked={draft.logo.enabled}
          disabled={working}
          onChange={event => onChange({ ...draft, logo: { ...draft.logo, enabled: event.target.checked } })}
        />启用 Logo</label>
        <label>位置<select
          className="input"
          value={draft.logo.position}
          disabled={working}
          onChange={event => onChange({ ...draft, logo: { ...draft.logo, position: event.target.value as LogoPosition } })}
        >
          {LOGO_POSITIONS.map(position => <option key={position} value={position}>{logoPositionLabels[position]}</option>)}
        </select></label>
      </div>
      <div className="brand-logo-grid">
        <div>
          <label className="field-label" htmlFor="brand-kit-logo-width">宽度（px，{LOGO_WIDTH_RANGE.min}–{LOGO_WIDTH_RANGE.max}）</label>
          <input
            id="brand-kit-logo-width"
            className="input"
            type="number"
            min={LOGO_WIDTH_RANGE.min}
            max={LOGO_WIDTH_RANGE.max}
            value={draft.logo.width}
            disabled={working}
            aria-invalid={Boolean(draftIssueFor(issues, 'logo.width'))}
            onChange={event => onChange({ ...draft, logo: { ...draft.logo, width: event.target.value } })}
          />
          <DraftFieldError issues={issues} field="logo.width" />
        </div>
        <div>
          <label className="field-label" htmlFor="brand-kit-logo-opacity">不透明度（0–1）</label>
          <input
            id="brand-kit-logo-opacity"
            className="input"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={draft.logo.opacity}
            disabled={working}
            aria-invalid={Boolean(draftIssueFor(issues, 'logo.opacity'))}
            onChange={event => onChange({ ...draft, logo: { ...draft.logo, opacity: event.target.value } })}
          />
          <DraftFieldError issues={issues} field="logo.opacity" />
        </div>
        <div>
          <label className="field-label" htmlFor="brand-kit-logo-margin">边距（px，{LOGO_MARGIN_RANGE.min}–{LOGO_MARGIN_RANGE.max}）</label>
          <input
            id="brand-kit-logo-margin"
            className="input"
            type="number"
            min={LOGO_MARGIN_RANGE.min}
            max={LOGO_MARGIN_RANGE.max}
            value={draft.logo.margin}
            disabled={working}
            aria-invalid={Boolean(draftIssueFor(issues, 'logo.margin'))}
            onChange={event => onChange({ ...draft, logo: { ...draft.logo, margin: event.target.value } })}
          />
          <DraftFieldError issues={issues} field="logo.margin" />
        </div>
      </div>
      <p className="hint">{noLogoHint ? '尚未上传 Logo：Logo 位置、尺寸与透明度会先保留在表单里；上传后才写入品牌库。' : 'Logo 为跨项目资源，项目快照只复制引用与副本，不会复制到每个场景。'}</p>

      {error && <p className="error-box" role="alert">{error}</p>}
      {notice && <p className="settings-success" role="status">{notice}</p>}
      <div className="v11-row brand-kit-form-actions">
        <button className="button primary" disabled={working || issues.length > 0} onClick={onSave}>{working ? '正在保存…' : editingId ? '保存修改' : '创建品牌套件'}</button>
        <button className="text-button" disabled={working} onClick={onCancel}>返回列表</button>
      </div>
    </div>
    <div className="brand-kit-preview-column">
      <BrandKitPreview draft={draft} />
    </div>
  </div>;
}

/** 删除确认：删除品牌库条目不影响已应用到项目的品牌快照。 */
export function BrandKitDeleteDialog({
  kit, working, error, onConfirm, onCancel,
}: {
  kit: BrandKit;
  working: boolean;
  error: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return <div className="modal-backdrop">
    <section className="modal manage-modal brand-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="brand-delete-title">
      <p className="eyebrow">DELETE BRAND KIT</p>
      <h2 id="brand-delete-title">删除品牌套件</h2>
      <p className="muted">确定删除「{kit.name}」吗？</p>
      <p className="brand-kit-note">{BRAND_KIT_DELETE_NOTE}</p>
      <p className="hint">删除后无法从品牌库恢复；需要时可以重新创建或从备份恢复。</p>
      {error && <p className="error-box" role="alert">{error}</p>}
      <div className="manage-actions">
        <button className="button subtle" disabled={working} onClick={onCancel}>取消</button>
        <button className="button danger" disabled={working} onClick={onConfirm}>{working ? '删除中…' : '确认删除'}</button>
      </div>
    </section>
  </div>;
}
