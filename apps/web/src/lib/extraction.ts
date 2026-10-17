/** Per-page extraction metadata shared by the pipeline, the re-run API and the review panel. */
export type PageMethod = 'text' | 'ocr' | 'none';
export type PageQuality = 'good' | 'fair' | 'poor';

export type PageInfo = {
  page: number;
  method: PageMethod;
  chars: number;
  quality: PageQuality;
  warnings: string[];
  tables?: number;
  images?: number;
  error?: string;
};

/** Raw page payload from the Python extractor: the review row plus the extracted body. */
export type ExtractedPage = PageInfo & { text?: string };

/** Drops the page body before the row is persisted into `extraction.json`. */
export function pageRecord(page: ExtractedPage): PageInfo {
  const { text: _text, ...info } = page;
  return info;
}

export type ExtractionMeta = {
  kind: 'pdf' | 'pptx' | 'markdown' | 'url' | 'text';
  filename?: string;
  pages?: number;
  ocrPages?: number[];
  failedPages?: { page: number; error: string }[];
  pageInfo?: PageInfo[];
  extractedAt: string;
};

const PAGE_HEADER = /^##\s*第\s*(\d+)\s*页\s*$/gm;

/** PDF text is stored as `## 第 N 页` sections so a single page can be replaced later. */
export function pageSections(text: string): { preamble: string; sections: { page: number; body: string }[] } {
  const matches = [...text.matchAll(PAGE_HEADER)];
  if (!matches.length) return { preamble: text.trim(), sections: [] };
  const preamble = text.slice(0, matches[0].index).trim();
  const sections = matches.map((match, index) => ({
    page: Number(match[1]),
    body: text.slice(match.index! + match[0].length, index + 1 < matches.length ? matches[index + 1].index : text.length).trim(),
  }));
  return { preamble, sections };
}

/**
 * Read-only lookup used by the storyboard's source-page peek. Sources without
 * page markers have no page numbers, so the whole body is shown instead.
 */
export function pageBody(text: string, page: number): { page: number; body: string; pages: number[]; missing: boolean } {
  const { preamble, sections } = pageSections(text);
  if (!sections.length) return { page, body: preamble, pages: [], missing: false };
  const match = sections.find(section => section.page === page);
  return { page, body: match?.body ?? '', pages: sections.map(section => section.page), missing: !match };
}

export function joinPageSections(preamble: string, sections: { page: number; body: string }[]): string {
  return [preamble.trim(), ...sections.map(section => `## 第 ${section.page} 页\n${section.body.trim()}`)].filter(Boolean).join('\n\n');
}

/**
 * Replaces only the requested pages and keeps every other page byte-identical.
 * Returns null when the source text was not extracted page by page (URL, PPTX, plain text).
 */
export function mergePageText(text: string, updates: { page: number; body: string }[]): string | null {
  const { preamble, sections } = pageSections(text);
  if (!sections.length) return null;
  const merged = new Map(sections.map(section => [section.page, section.body]));
  for (const update of updates) merged.set(update.page, update.body.trim());
  return joinPageSections(preamble, [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([page, body]) => ({ page, body })));
}

/**
 * Old projects only stored `ocrPages`/`failedPages`; synthesise review rows so the panel still works.
 * A pageInfo shorter than the page count (a re-run used to overwrite it) is padded, not trusted.
 */
export function normalizePageInfo(meta: Partial<ExtractionMeta> | null | undefined): PageInfo[] {
  if (!meta) return [];
  const stored = [...(meta.pageInfo ?? [])].sort((a, b) => a.page - b.page);
  const total = meta.kind === 'pdf' ? Math.max(meta.pages ?? 0, stored.at(-1)?.page ?? 0) : 0;
  if (!total) return stored;
  const known = new Map(stored.map(page => [page.page, page]));
  const ocr = new Set(meta.ocrPages ?? []);
  const failed = new Map((meta.failedPages ?? []).map(item => [item.page, item.error]));
  return Array.from({ length: total }, (_, index) => {
    const page = index + 1;
    const existing = known.get(page);
    if (existing) return existing;
    const error = failed.get(page);
    return {
      page,
      method: error ? 'none' as const : ocr.has(page) ? 'ocr' as const : 'text' as const,
      chars: 0,
      quality: error ? 'poor' as const : 'fair' as const,
      warnings: error ? [] : ['旧版抽取记录没有逐页统计，重跑此页可获得质量评估'],
      ...(error ? { error } : {}),
    };
  });
}

/** Pages worth a second look: failed, empty, low confidence, or flagged during extraction. */
export function reviewPages(pageInfo: PageInfo[] | undefined): number[] {
  return (pageInfo ?? []).filter(item => item.error || item.quality !== 'good' || item.warnings.length > 0).map(item => item.page);
}

export function pageQualityLabel(quality: PageQuality): string {
  return ({ good: '良好', fair: '需复核', poor: '识别不佳' })[quality];
}

export function pageMethodLabel(method: PageMethod): string {
  return ({ text: '文本层', ocr: 'OCR', none: '失败' })[method];
}
