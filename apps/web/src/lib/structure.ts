export type SourcePage = { label: string; body: string | string[] };

export type TableFinding = {
  page: number;
  pageLabel: string;
  index: number;
  columns: number;
  rows: number;
  header: string[];
  preview: string[];
  issues: string[];
};

export type ListFinding = {
  page: number;
  pageLabel: string;
  index: number;
  ordered: boolean;
  items: number;
  depth: number;
  preview: string[];
  issues: string[];
};

export type OrderRow = {
  position: number;
  page: number | null;
  label: string;
  chars: number;
  issues: string[];
};

export type OrderReport = {
  rows: OrderRow[];
  duplicates: number[];
  gaps: number[];
  outOfOrder: number[];
  unnumbered: number[];
  empty: number[];
};

const PAGE_NUMBER = /第\s*(\d+)\s*页|幻灯片\s*(\d+)/;
const TABLE_ROW = /^\|.*\|$/;
const TABLE_DIVIDER = /^:?-{2,}:?$/;
const LIST_LINE = /^([ \t]*)([-*•]|\d+[.)])(?:[ \t]+(.*))?$/;
const EMPTY_PAGE_CHARS = 10;
const INDENT_WIDTH = (indent: string) => indent.replace(/\t/g, '  ').length;
const bodyText = (page: SourcePage) => Array.isArray(page.body) ? page.body.join('\n') : page.body;

export function pageNumberOf(label: string): number | null {
  const match = PAGE_NUMBER.exec(label);
  if (!match) return null;
  const value = Number(match[1] ?? match[2]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function tableCells(line: string) { return line.trim().slice(1, -1).split('|').map(cell => cell.trim()); }

/** Every markdown table in the source, with the shape problems that matter when OCR stitches columns together. */
export function scanTables(pages: SourcePage[]): TableFinding[] {
  const found: TableFinding[] = [];
  pages.forEach((page, pageIndex) => {
    let block: string[][] = [];
    let perPage = 0;
    const flush = () => {
      if (!block.length) return;
      const rows = block; block = [];
      perPage += 1;
      const [header = [], ...data] = rows;
      const widths = [...new Set(rows.map(row => row.length))].sort((a, b) => a - b);
      const issues: string[] = [];
      if (widths.length > 1) issues.push(`列数不一致（${widths.join('/')} 列），可能是 OCR 把跨列表格串成一行`);
      if (!data.length) issues.push('只有表头，没有数据行');
      const emptyCells = rows.reduce((total, row) => total + row.filter(cell => !cell).length, 0);
      if (emptyCells) issues.push(`${emptyCells} 个空单元格`);
      const emptyHeaders = header.filter(cell => !cell).length;
      if (emptyHeaders) issues.push(`${emptyHeaders} 个表头为空`);
      found.push({
        page: pageIndex + 1,
        pageLabel: page.label,
        index: perPage,
        columns: widths[widths.length - 1] ?? 0,
        rows: data.length,
        header,
        preview: data.slice(0, 2).map(row => row.join(' | ')),
        issues,
      });
    };
    for (const line of bodyText(page).split('\n')) {
      const trimmed = line.trim();
      if (TABLE_ROW.test(trimmed)) {
        const cells = tableCells(trimmed);
        if (!cells.every(cell => TABLE_DIVIDER.test(cell))) block.push(cells);
        continue;
      }
      flush();
    }
    flush();
  });
  return found;
}

function numberingIssues(items: string[]): string[] {
  const issues = new Set<string>();
  if (!items.length) return [];
  const numbers = items.map(item => Number(item.replace(/\D/g, '')));
  if (numbers[0] !== 1) issues.add(`编号从 ${numbers[0]} 开始`);
  for (let index = 1; index < numbers.length; index += 1) {
    const previous = numbers[index - 1], current = numbers[index];
    if (current === previous) issues.add(`编号重复（${current}）`);
    else if (current === previous + 1) continue;
    else if (current > previous + 1) issues.add(`缺少编号 ${previous + 1}~${current - 1}`);
    else issues.add(`编号回退（${previous} → ${current}）`);
  }
  return [...issues];
}

/** Every ordered/unordered list in the source, with numbering and nesting problems called out. */
export function scanLists(pages: SourcePage[]): ListFinding[] {
  const found: ListFinding[] = [];
  pages.forEach((page, pageIndex) => {
    let group: { ordered: boolean; indent: number; marker: string; text: string }[] = [];
    let perPage = 0;
    const flush = () => {
      if (!group.length) return;
      const items = group; group = [];
      perPage += 1;
      const ordered = items[0].ordered;
      const issues: string[] = [];
      const empty = items.filter(item => !item.text.trim()).length;
      if (empty) issues.push(`${empty} 个条目只有记号没有内容`);
      if (ordered) {
        const top = items.filter(item => item.indent === Math.min(...items.map(entry => entry.indent)));
        issues.push(...numberingIssues(top.map(item => item.marker)));
      }
      found.push({
        page: pageIndex + 1,
        pageLabel: page.label,
        index: perPage,
        ordered,
        items: items.length,
        depth: Math.max(...items.map(item => Math.floor(item.indent / 2))) + 1,
        preview: items.slice(0, 3).map(item => item.text.trim() || '（空条目）'),
        issues,
      });
    };
    for (const line of bodyText(page).split('\n')) {
      const match = LIST_LINE.exec(line);
      if (!match) { flush(); continue; }
      const [, indent, marker, text = ''] = match;
      const ordered = /\d/.test(marker);
      if (group.length && group[0].ordered !== ordered) flush();
      group.push({ ordered, indent: INDENT_WIDTH(indent), marker, text });
    }
    flush();
  });
  return found;
}

/** Page order review: what the markers claim versus what the bodies actually contain. */
export function scanPageOrder(pages: SourcePage[]): OrderReport {
  const rows: OrderRow[] = pages.map((page, index) => {
    const number = pageNumberOf(page.label);
    const chars = bodyText(page).replace(/\s+/g, '').length;
    const issues: string[] = [];
    if (number === null) issues.push('无法识别页码');
    if (chars < EMPTY_PAGE_CHARS) issues.push('几乎没有文字');
    return { position: index + 1, page: number, label: page.label, chars, issues };
  });
  const counts = new Map<number, number>();
  for (const row of rows) if (row.page !== null) counts.set(row.page, (counts.get(row.page) ?? 0) + 1);
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([page]) => page).sort((a, b) => a - b);
  for (const row of rows) if (row.page !== null && (counts.get(row.page) ?? 0) > 1) row.issues.push('页码重复');
  const numbers = rows.map(row => row.page).filter((page): page is number => page !== null);
  const known = new Set(numbers);
  const gaps: number[] = [];
  if (numbers.length) for (let page = 1; page <= Math.max(...numbers); page += 1) if (!known.has(page)) gaps.push(page);
  const outOfOrder: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.page === null) continue;
    const previous = rows.slice(0, index).reverse().find(item => item.page !== null)?.page ?? null;
    if (previous !== null && row.page < previous) {
      outOfOrder.push(row.position);
      row.issues.push(`顺序错乱（第 ${row.page} 页排在第 ${previous} 页之后）`);
    }
    if (previous !== null && row.page > previous + 1) row.issues.push(`缺少第 ${previous + 1}~${row.page - 1} 页`);
  }
  return {
    rows,
    duplicates,
    gaps,
    outOfOrder,
    unnumbered: rows.filter(row => row.page === null).map(row => row.position),
    empty: rows.filter(row => row.chars < EMPTY_PAGE_CHARS).map(row => row.position),
  };
}
