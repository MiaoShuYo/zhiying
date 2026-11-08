import { BrandSnapshotSchema, type BrandKit, type BrandPalette, type BrandSnapshot, type StyleId } from '@m2v/schema';
import { palettes, styles } from '@m2v/styles';

/**
 * V1.6.7 品牌套件 UI 的纯函数与常量。
 *
 * 这里不碰浏览器 API，也不引用 Node 模块，交互组件与静态渲染测试共用同一套
 * 校验 / 草稿 / 预览逻辑。品牌 = 颜色 + 字体 + Logo，不包含声音、字幕或导出参数。
 */

export const STYLE_IDS: StyleId[] = ['minimal-tech', 'clean-light', 'academic', 'social-short', 'whiteboard'];

export const PALETTE_KEYS = ['bg', 'fg', 'muted', 'accent', 'card', 'secondary'] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];

/** 六个 renderer palette 字段在界面上的中文名，顺序与表单一致。 */
export const paletteLabels: Record<PaletteKey, string> = {
  bg: '背景',
  fg: '正文',
  muted: '弱文字',
  accent: '强调',
  card: '卡片',
  secondary: '辅助',
};

export const LOGO_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type LogoPosition = (typeof LOGO_POSITIONS)[number];

export const logoPositionLabels: Record<LogoPosition, string> = {
  'top-left': '左上',
  'top-right': '右上',
  'bottom-left': '左下',
  'bottom-right': '右下',
};

export const MAX_BRAND_KIT_NAME = 40;

/** 与 BrandLogoSchema 的边界保持一致，表单在提交前就能拦截。 */
export const LOGO_WIDTH_RANGE = { min: 40, max: 500 } as const;
export const LOGO_MARGIN_RANGE = { min: 0, max: 200 } as const;

export type LogoDraft = {
  /** 已上传 Logo 的库内路径；新建流程在保存前只有本地 File。 */
  src?: string;
  enabled: boolean;
  position: LogoPosition;
  width: string;
  opacity: string;
  margin: string;
};

export type BrandKitDraft = {
  name: string;
  baseStyleId: StyleId;
  colors: Record<PaletteKey, string>;
  typography: { headingFont: string; bodyFont: string };
  logo: LogoDraft;
};

export type BrandKitDraftIssue = { field: string; message: string };

/** 删除确认里必须保留 snapshot 语义：删除库条目不会破坏已应用到项目的品牌快照。 */
export const BRAND_KIT_DELETE_NOTE = '已应用到项目的品牌快照会继续保留；删除只会移除品牌库中的套件。';

export function brandKitLimitMessage(max: number): string {
  return `已达上限 ${max} 个，删除不用的品牌套件后可继续创建。`;
}

/** Accepts `#RRGGBB` or bare `RRGGBB`; returns the normalized lowercase form or null. */
export function normalizeHex(value: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? `#${match[1]!.toLowerCase()}` : null;
}

export function isHexColor(value: string): boolean {
  return normalizeHex(value) !== null;
}

export function brandKitStyleName(styleId: string): string {
  return styles[styleId as StyleId]?.name ?? styleId;
}

export function brandKitOptionLabel(kit: Pick<BrandKit, 'name' | 'isDefault'>): string {
  return `${kit.name}${kit.isDefault ? '（默认）' : ''}`;
}

/** 本地品牌资源都放在 public/ 下；加前导斜杠，避免在 /project/<id> 这类路径下被当成相对地址解析。 */
export function publicAssetUrl(src: string): string {
  if (/^(?:https?:)?\/\//.test(src) || src.startsWith('/')) return src;
  return `/${src}`;
}

export function brandKitUpdatedLabel(kit: Pick<BrandKit, 'updatedAt'>): string {
  const date = new Date(kit.updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN');
}

/** New brand starts from the chosen base style's palette so the preview is never blank. */
export function defaultBrandDraft(styleId: StyleId = 'minimal-tech'): BrandKitDraft {
  const style = styles[styleId];
  return {
    name: '',
    baseStyleId: styleId,
    colors: { ...palettes[styleId] },
    typography: { headingFont: style.typography.headingFont, bodyFont: style.typography.bodyFont },
    logo: { enabled: true, position: 'top-right', width: '160', opacity: '1', margin: '40' },
  };
}

export function draftFromKit(kit: BrandKit): BrandKitDraft {
  return {
    name: kit.name,
    baseStyleId: kit.baseStyleId,
    colors: { ...kit.colors },
    typography: { ...kit.typography },
    logo: kit.logo
      ? {
        src: kit.logo.src,
        enabled: kit.logo.enabled,
        position: kit.logo.position,
        width: String(kit.logo.width),
        opacity: String(kit.logo.opacity),
        margin: String(kit.logo.margin),
      }
      : { enabled: true, position: 'top-right', width: '160', opacity: '1', margin: '40' },
  };
}

function numberIssue(value: string, min: number, max: number, field: string, label: string): BrandKitDraftIssue | null {
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed)) return { field, message: `${label}必须是数字` };
  if (parsed < min || parsed > max) return { field, message: `${label}需在 ${min}–${max} 之间` };
  return null;
}

/** Field-level validation shared by the form (inline hints) and the submit path (never sends invalid data). */
export function validateBrandKitDraft(draft: BrandKitDraft): BrandKitDraftIssue[] {
  const issues: BrandKitDraftIssue[] = [];
  const name = draft.name.trim();
  if (!name) issues.push({ field: 'name', message: '请填写品牌套件名称' });
  else if (name.length > MAX_BRAND_KIT_NAME) issues.push({ field: 'name', message: `品牌套件名称不能超过 ${MAX_BRAND_KIT_NAME} 个字符` });

  for (const key of PALETTE_KEYS) {
    if (!normalizeHex(draft.colors[key])) issues.push({ field: `colors.${key}`, message: `${paletteLabels[key]}颜色必须是 #RRGGBB 格式` });
  }

  if (!draft.typography.headingFont.trim()) issues.push({ field: 'typography.headingFont', message: '请填写标题字体' });
  if (!draft.typography.bodyFont.trim()) issues.push({ field: 'typography.bodyFont', message: '请填写正文字体' });

  const widthIssue = numberIssue(draft.logo.width, LOGO_WIDTH_RANGE.min, LOGO_WIDTH_RANGE.max, 'logo.width', 'Logo 宽度');
  if (widthIssue) issues.push(widthIssue);
  const opacityIssue = numberIssue(draft.logo.opacity, 0, 1, 'logo.opacity', 'Logo 不透明度');
  if (opacityIssue) issues.push(opacityIssue);
  const marginIssue = numberIssue(draft.logo.margin, LOGO_MARGIN_RANGE.min, LOGO_MARGIN_RANGE.max, 'logo.margin', 'Logo 边距');
  if (marginIssue) issues.push(marginIssue);

  return issues;
}

export function draftIssueFor(issues: BrandKitDraftIssue[], field: string): BrandKitDraftIssue | undefined {
  return issues.find(issue => issue.field === field);
}

export function normalizedPalette(colors: Record<PaletteKey, string>, fallback: BrandPalette): BrandPalette {
  const palette = { ...fallback };
  for (const key of PALETTE_KEYS) palette[key] = normalizeHex(colors[key]) ?? fallback[key];
  return palette;
}

/** Colors used by the live preview; invalid drafts fall back to the base style palette instead of crashing. */
export function previewPalette(draft: BrandKitDraft): BrandPalette {
  return normalizedPalette(draft.colors, palettes[draft.baseStyleId] ?? palettes['minimal-tech']);
}

export type BrandKitDraftPayload =
  | { ok: true; value: BrandSnapshot }
  | { ok: false; issues: BrandKitDraftIssue[] };

/**
 * Builds the exact BrandSnapshot body accepted by POST/PATCH /api/settings/brand-kits.
 * Invalid hex values are rejected here, so the UI can disable submit and the network
 * request never carries a bad palette.
 */
export function brandDraftPayload(draft: BrandKitDraft): BrandKitDraftPayload {
  const issues = validateBrandKitDraft(draft);
  if (issues.length) return { ok: false, issues };
  const logo = draft.logo.src?.trim()
    ? {
      src: draft.logo.src.trim(),
      enabled: draft.logo.enabled,
      position: draft.logo.position,
      width: Number(draft.logo.width),
      opacity: Number(draft.logo.opacity),
      margin: Number(draft.logo.margin),
    }
    : undefined;
  const candidate = {
    name: draft.name.trim(),
    baseStyleId: draft.baseStyleId,
    colors: normalizedPalette(draft.colors, palettes[draft.baseStyleId]),
    typography: {
      headingFont: draft.typography.headingFont.trim(),
      bodyFont: draft.typography.bodyFont.trim(),
    },
    ...(logo ? { logo } : {}),
  };
  const parsed = BrandSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) };
  }
  return { ok: true, value: parsed.data };
}

/** Logo geometry is deterministic: width/margin are design-canvas pixels scaled into the preview. */
export function logoWidthPercent(width: string): number {
  const parsed = Number(width);
  const value = Number.isFinite(parsed) ? parsed : 160;
  return Math.min(40, Math.max(4, (value / 1920) * 100));
}

export function logoMarginPercent(margin: string): number {
  const parsed = Number(margin);
  const value = Number.isFinite(parsed) ? parsed : 40;
  return Math.min(15, Math.max(0, (value / 1920) * 100));
}

/** Font stack for previews; the renderer resolves the full stack, this only needs to be close. */
export function previewFontFamily(fontName: string): string {
  const name = fontName.trim() || 'Arial';
  return `${name}, 'Noto Sans SC', sans-serif`;
}

/**
 * Brand switches only touch the visual snapshot. The confirm dialog lists both sides
 * explicitly so users know narration, audio and timings are not regenerated.
 */
export const BRAND_CHANGE_UPDATES = ['品牌颜色', '标题/正文字体', 'Logo'] as const;
export const BRAND_CHANGE_KEEPS = ['旁白', '分镜内容', '配音', '语速/停顿', '字幕时间', '场景时长', '制作方案'] as const;

export function brandChangeHeading(kind: 'apply' | 'remove'): string {
  return kind === 'apply' ? '将更新' : '将移除';
}
