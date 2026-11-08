import type { CSSProperties } from 'react';
import type { BrandKit } from '@m2v/schema';
import {
  PALETTE_KEYS,
  brandKitStyleName,
  logoMarginPercent,
  logoWidthPercent,
  paletteLabels,
  previewFontFamily,
  previewPalette,
  publicAssetUrl,
  type BrandKitDraft,
} from '@/lib/brand-kit-ui';

/**
 * 品牌预览与卡片的纯展示组件。
 *
 * MVP 不调用完整 renderer：这里是一个确定性静态卡片，只验证调色板、字体与 Logo
 * 位置等主题配置，不代表最终 SceneView 的像素级效果。组件没有 hooks/浏览器 API，
 * 因此在没有 jsdom 的测试环境里可以直接 renderToStaticMarkup。
 */

function logoPositionStyle(draft: BrandKitDraft): CSSProperties {
  const logo = draft.logo;
  const edge = logoMarginPercent(logo.margin);
  const opacity = Number(logo.opacity);
  const style: CSSProperties = {
    width: `${logoWidthPercent(logo.width)}%`,
    opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1,
  };
  if (logo.position.startsWith('top')) style.top = `${edge}%`;
  else style.bottom = `${edge}%`;
  if (logo.position.endsWith('left')) style.left = `${edge}%`;
  else style.right = `${edge}%`;
  return style;
}

export function BrandKitPreview({ draft }: { draft: BrandKitDraft }) {
  const palette = previewPalette(draft);
  const headingFamily = previewFontFamily(draft.typography.headingFont);
  const bodyFamily = previewFontFamily(draft.typography.bodyFont);
  const logo = draft.logo;
  return <figure className="brand-preview">
    <div className="brand-preview-canvas" style={{ background: palette.bg, color: palette.fg, fontFamily: bodyFamily }}>
      {logo.enabled && <div className="brand-preview-logo" style={logoPositionStyle(draft)}>
        {logo.src
          ? <img src={publicAssetUrl(logo.src)} alt="品牌 Logo 预览" />
          : <span style={{ color: palette.accent }}>LOGO</span>}
      </div>}
      <p className="brand-preview-eyebrow" style={{ color: palette.accent }}>BRAND PREVIEW</p>
      <h4 style={{ color: palette.fg, fontFamily: headingFamily }}>让品牌与知识一起被记住</h4>
      <p style={{ color: palette.muted }}>品牌颜色、字体与 Logo 会应用到项目里的每个场景，不改变旁白与配音。</p>
      <div className="brand-preview-card" style={{ background: palette.card, borderColor: palette.secondary }}>
        <b style={{ color: palette.fg, fontFamily: headingFamily }}>关键结论</b>
        <span style={{ color: palette.muted }}>静态预览只验证品牌主题配置。</span>
      </div>
      <div className="brand-preview-actions">
        <span className="brand-preview-accent" style={{ background: palette.accent, color: palette.bg }}>重点强调</span>
        <span className="brand-preview-muted" style={{ borderColor: palette.secondary, color: palette.secondary }}>辅助信息</span>
      </div>
    </div>
    <figcaption>实时预览仅验证品牌主题配置，不代表最终 SceneView 像素级效果；改颜色、字体或 Logo 会立即刷新。</figcaption>
  </figure>;
}

/** Six-color simplified palette shared by library cards and the project picker. */
export function PaletteSwatches({ colors, label }: { colors: BrandKitDraft['colors'] | BrandKit['colors']; label?: string }) {
  return <span className="brand-kit-swatches" aria-label={label ?? '品牌色板'}>
    {PALETTE_KEYS.map(key => <i key={key} title={`${paletteLabels[key]} ${colors[key]}`} style={{ background: colors[key] }} />)}
  </span>;
}

/** Library list card: Logo thumbnail, name, default marker, six swatches, base style and actions. */
export function BrandKitCard({
  kit, disabled, onEdit, onDuplicate, onSetDefault, onDelete,
}: {
  kit: BrandKit;
  disabled: boolean;
  onEdit: (kit: BrandKit) => void;
  onDuplicate: (kit: BrandKit) => void;
  onSetDefault: (kit: BrandKit) => void;
  onDelete: (kit: BrandKit) => void;
}) {
  return <article className={`brand-kit-card${kit.isDefault ? ' is-default' : ''}`}>
    <div className="brand-kit-card-top">
      <div className="brand-kit-logo">{kit.logo?.src ? <img src={publicAssetUrl(kit.logo.src)} alt={`${kit.name} Logo`} /> : <span>无 Logo</span>}</div>
      <div className="brand-kit-card-copy">
        <h3>{kit.name}{kit.isDefault ? <span className="preset-default">默认</span> : null}</h3>
        <PaletteSwatches colors={kit.colors} />
        <small>基础 Style：{brandKitStyleName(kit.baseStyleId)}</small>
      </div>
    </div>
    <div className="brand-kit-actions">
      <button className="button subtle" disabled={disabled} onClick={() => onEdit(kit)}>编辑</button>
      <button className="text-button" disabled={disabled} onClick={() => onDuplicate(kit)}>复制</button>
      {!kit.isDefault && <button className="text-button" disabled={disabled} onClick={() => onSetDefault(kit)}>设为默认</button>}
      <button className="text-button" disabled={disabled} onClick={() => onDelete(kit)}>删除</button>
    </div>
  </article>;
}

/** One brand kit row inside the project-editor picker. */
export function BrandKitOption({
  kit, selected, disabled, onSelect,
}: {
  kit: BrandKit;
  selected: boolean;
  disabled: boolean;
  onSelect: (kit: BrandKit) => void;
}) {
  return <button
    type="button"
    className={`brand-picker-option${selected ? ' selected' : ''}`}
    disabled={disabled}
    aria-pressed={selected}
    onClick={() => onSelect(kit)}
  >
    <span className="brand-kit-logo">{kit.logo?.src ? <img src={publicAssetUrl(kit.logo.src)} alt={`${kit.name} Logo`} /> : <span>无 Logo</span>}</span>
    <span className="brand-picker-option-copy">
      <b>{kit.name}{kit.isDefault ? <span className="preset-default">默认</span> : null}{selected ? <span className="brand-picker-current">当前</span> : null}</b>
      <small>基础 Style：{brandKitStyleName(kit.baseStyleId)}</small>
    </span>
    <PaletteSwatches colors={kit.colors} label={`${kit.name} 色板`} />
  </button>;
}
