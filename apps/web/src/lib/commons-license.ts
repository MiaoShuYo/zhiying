export type LicenseClass = 'public-domain' | 'cc-by' | 'cc-by-sa' | 'other' | 'unknown';

export type CommonsCredit = {
  attribution: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  licenseClass: LicenseClass;
  requiresAttribution: boolean;
  warnings: string[];
};

export const UNKNOWN_LICENSE = '许可信息未提供';

type Metadata = Record<string, { value?: string }>;

const strip = (value: string) => value.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Wikimedia's license strings are free-form, so classify them instead of trusting the raw label. */
export function classifyLicense(license: string): LicenseClass {
  const text = license.toLowerCase();
  if (!text) return 'unknown';
  if (/cc0|public domain|pd-|no restrictions|pdself|gfdl/.test(text)) return 'public-domain';
  if (/cc[\s-]?by[\s-]?sa|attribution[\s-]?sharealike/.test(text)) return 'cc-by-sa';
  if (/cc[\s-]?by|attribution/.test(text)) return 'cc-by';
  return 'other';
}

export function readCredit(meta: Metadata, sourceUrl: string): CommonsCredit {
  const clean = (key: string) => strip(meta[key]?.value ?? '');
  const attribution = clean('Attribution') || clean('Artist') || clean('Credit');
  const license = clean('LicenseShortName') || clean('License') || '';
  const licenseUrl = clean('LicenseUrl');
  const licenseClass = classifyLicense(license);
  const warnings: string[] = [];
  if (licenseClass === 'unknown') warnings.push('未取得许可信息，使用前请到来源页面确认授权范围');
  else if (licenseClass === 'other') warnings.push(`许可协议「${license}」需要人工确认署名方式与商用限制`);
  if (licenseClass === 'cc-by' || licenseClass === 'cc-by-sa') warnings.push(`该图片要求署名（${licenseClass === 'cc-by-sa' ? 'CC BY-SA' : 'CC BY'}），导出时会写入画面角标`);
  if (!attribution && licenseClass !== 'public-domain') warnings.push('未取得作者署名信息，请在来源页面补充后再导出');
  return { attribution, license: license || UNKNOWN_LICENSE, licenseUrl, sourceUrl, licenseClass, requiresAttribution: licenseClass === 'cc-by' || licenseClass === 'cc-by-sa', warnings };
}
