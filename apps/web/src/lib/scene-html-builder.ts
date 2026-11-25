/**
 * Builds the HTML-mode layout of a scene from its structured data. Kept free of Node APIs so the
 * editor can rebuild a scene's markup in the browser as soon as its source fields change (#203).
 */
import { SCENE_HTML_PALETTES, codeLines, codeVisualOf, sanitizeSceneHtml, type Scene } from '@m2v/schema';

// #189: the palettes live in @m2v/schema so the renderer can map them onto a Brand Snapshot.
export { SCENE_HTML_PALETTES };

/**
 * #206: the formula paragraph carries this class so the renderer can typeset `visual.formula` with
 * KaTeX after sanitizing. The escaped LaTeX stays inside as the fallback text.
 */
export const MATH_FORMULA_CLASS = 'm2v-math-formula';

export function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function comparisonColumns(input: unknown): { heading: unknown; items: unknown[] }[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 2).map((column, index) => {
    const record = column && typeof column === 'object' && !Array.isArray(column) ? column as Record<string, unknown> : {};
    const heading = [record.title, record.name, record.label, record.heading, record.option, record.key].find(value => typeof value === 'string' && value.trim());
    const rawItems = [record.items, record.points, record.bullets, record.features, record.details, record.advantages, record.content, record.description].find(value => Array.isArray(value) || typeof value === 'string');
    const items = Array.isArray(rawItems) ? rawItems : typeof rawItems === 'string' ? rawItems.split(/[。；\n]/).filter(Boolean) : [];
    return { heading: heading ?? `方案 ${index + 1}`, items };
  });
}

/** Build a dense, type-specific HTML layout from the structured scene data. */
export function structuredSceneHtml(scene: Scene, index: number): string {
  const esc = (value: unknown) => escapeHtmlText(typeof value === 'string' ? value : String(value ?? ''));
  const multiline = (value: unknown) => esc(value).replace(/\r\n?|\n/g, '<br>');
  const title = esc(scene.title ?? '本章重点');
  const palette = SCENE_HTML_PALETTES[((index % 4) + 4) % 4];
  const card = (body: string, extra = '') => `<div style="flex:1;min-width:180px;padding:20px;border:1px solid ${palette.a}88;border-radius:18px;background:linear-gradient(145deg,${palette.bg},#202a45);box-shadow:0 8px 28px #00000055;${extra}">${body}</div>`;
  const label = (value: unknown) => `<span style="font-size:17px;color:${palette.b};font-weight:700">${esc(value)}</span>`;
  const body = (value: unknown) => `<p style="font-size:24px;font-weight:600;line-height:1.35;color:#fff;margin:10px 0 0">${esc(value)}</p>`;
  let content = '';
  switch (scene.type) {
    case 'title': content = `<div style="display:flex;flex-direction:column;gap:18px">${label('章节导览')}<h1 style="font-size:58px;line-height:1.08;color:#fff;margin:0">${title}</h1>${body(scene.narration)}</div>`; break;
    case 'text': content = `<div style="display:flex;flex-direction:column;gap:18px">${label('核心内容')}<h1 style="font-size:46px;color:#fff;margin:0">${title}</h1>${card(`<p style="font-size:28px;line-height:1.5;color:#fff;margin:0">${multiline(scene.visual.text ?? scene.narration)}</p>`, 'width:100%;box-sizing:border-box')}</div>`; break;
    case 'bullets': {
      const items = Array.isArray(scene.visual.items) ? scene.visual.items : [];
      content = `<div style="display:flex;flex-direction:column;gap:16px">${label('关键要点')}<h1 style="font-size:46px;color:#fff;margin:0">${title}</h1><div style="display:flex;flex-wrap:wrap;gap:14px">${items.map((item, i) => { const record = item && typeof item === 'object' ? item as Record<string, unknown> : null; const text = record ? record.text : item; const children = record && Array.isArray(record.children) ? record.children : []; return card(`<span style="font-size:20px;color:${palette.b};font-weight:800">${String(i + 1).padStart(2, '0')}</span>${body(text)}${children.map(child => `<p style="font-size:18px;line-height:1.3;color:#cbd5e1;margin:8px 0 0">↳ ${esc(child)}</p>`).join('')}`); }).join('')}</div></div>`; break;
    }
    case 'comparison': {
      const normalized = comparisonColumns(scene.visual.columns);
      const hasDetails = normalized.length === 2 && normalized.every(column => column.items.length > 0);
      const schematic = scene.visual.layout === 'diagram';
      const columns = normalized.map((column, i) => card(`${label(column.heading)}${column.items.map(item => { const value = item && typeof item === 'object' && !Array.isArray(item) ? [((item as Record<string, unknown>).text), ((item as Record<string, unknown>).label), ((item as Record<string, unknown>).title), ((item as Record<string, unknown>).content)].find(field => typeof field === 'string' && field.trim()) : item; return schematic ? `<div style="padding:8px 14px;margin:10px 0 0 14px;border-left:3px solid ${palette.b};background:#0a1020;color:#fff;font-size:23px">${esc(value)}</div>` : body(value ?? JSON.stringify(item)); }).join('')}`, `border-color:${i ? palette.b : palette.a}`));
      content = `<div style="display:flex;flex-direction:column;gap:18px">${label('双向对照')}<h1 style="font-size:46px;color:#fff;margin:0">${title}</h1><div style="display:flex;gap:18px">${columns.join(schematic ? `<span style="align-self:center;color:${palette.b};font-size:40px">↔</span>` : '')}</div>${!hasDetails ? card(`<p style="font-size:24px;line-height:1.45;color:#fff;margin:0">${esc(scene.narration)}</p>`, 'width:100%;box-sizing:border-box') : ''}</div>`; break;
    }
    case 'diagram':
    case 'chart': {
      const data = Array.isArray(scene.visual.data) ? scene.visual.data : [];
      const rows = data.filter((item): item is { label: string; value: number } => Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).label === 'string' && typeof (item as Record<string, unknown>).value === 'number'));
      const matrix = data.length > 1 && data.every(row => Array.isArray(row)) ? data as unknown[][] : [];
      const nodes = Array.isArray(scene.visual.nodes) ? scene.visual.nodes : [];
      const nodeLabel = (node: unknown) => {
        if (typeof node === 'string') return node;
        if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
        const record = node as Record<string, unknown>;
        const nested = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : {};
        return [record.label, nested.label, record.title, nested.title, record.text, nested.text, record.content, nested.content, record.description, nested.description, record.name].find(value => typeof value === 'string' && value.trim()) ?? '';
      };
      const maximum = Math.max(1, ...rows.map(item => item.value));
      const matrixTable = matrix.length ? `<table style="width:100%;border-collapse:collapse;color:#fff;font-size:20px"><thead><tr>${matrix[0].map(cell => `<th style="padding:12px;border:1px solid ${palette.a};text-align:left">${esc(cell)}</th>`).join('')}</tr></thead><tbody>${matrix.slice(1).map((row, ri) => `<tr>${row.map(cell => `<td style="padding:11px;border:1px solid #ffffff44;background:${ri % 2 ? '#151d32' : '#222b43'}">${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
      const chart = rows.length ? `<div style="display:flex;align-items:end;gap:14px;height:250px">${rows.map((item, i) => `<div style="flex:1;text-align:center;color:#fff"><span style="font-size:18px">${esc(item.value)}</span><div style="height:${Math.max(14, 170 * item.value / maximum)}px;margin:8px 0;background:linear-gradient(180deg,${i % 2 ? palette.b : palette.a},${palette.bg});border-radius:12px 12px 2px 2px"></div><span style="font-size:17px">${esc(item.label)}</span></div>`).join('')}</div>` : matrixTable || `<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px">${nodes.map((node, i) => `${card(`<p style="font-size:23px;color:#fff;margin:0">${esc(nodeLabel(node))}</p>`)}${i < nodes.length - 1 ? `<span style="font-size:32px;color:${palette.b}">→</span>` : ''}`).join('')}</div>`;
      content = `<div style="display:flex;flex-direction:column;gap:18px">${label(rows.length || matrix.length ? '数据图表' : '流程图示')}<h1 style="font-size:46px;color:#fff;margin:0">${title}</h1>${card(chart || `<p style="font-size:24px;line-height:1.45;color:#fff">${esc(scene.narration)}</p>`, 'width:100%;box-sizing:border-box')}</div>`; break;
    }
    case 'code': {
      const codeVisual = codeVisualOf(scene.visual);
      if (codeVisual) {
        // Standard and HTML modes consume the exact same `code/language/filename/beats` data.
        const sourceLines = codeLines(codeVisual.code);
        const beats = codeVisual.beats ?? [];
        const activeLines = new Set(beats.flatMap(beat => beat.lines));
        const header = [codeVisual.filename, codeVisual.language]
          .filter((value): value is string => Boolean(value && value.trim()))
          .map(value => `<span style="font-size:19px;color:${palette.b};font-weight:700">${esc(value)}</span>`)
          .join('<span style="font-size:19px;color:#64748b"> · </span>');
        const codeRows = sourceLines.map((sourceLine, lineIndex) => {
          const lineNumber = lineIndex + 1;
          const active = beats.length > 0 && activeLines.has(lineNumber);
          const dimmed = beats.length > 0 && !active;
          const color = beats.length === 0 ? '#e2e8f0' : active ? '#ffffff' : '#8b98ab';
          const background = active ? `${palette.a}33` : 'transparent';
          const classes = `code-line${active ? ' code-line-active' : ''}${dimmed ? ' code-line-dim' : ''}`;
          return `<div class="${classes}" data-line-number="${lineNumber}"${active ? ' data-active="true"' : ''}${dimmed ? ' data-dimmed="true"' : ''} style="display:flex;gap:18px;padding:1px 12px;font-size:20px;line-height:1.55;color:${color};background:${background};white-space:pre"><span class="code-line-number" style="min-width:52px;text-align:right;color:#7c8ba1">${lineNumber}</span><span class="code-line-text" style="white-space:pre">${esc(sourceLine) || ' '}</span></div>`;
        }).join('');
        const beatLabels = beats
          .filter(beat => beat.label)
          .map(beat => `<span style="font-size:19px;line-height:1.3;color:#fff;padding:8px 14px;border:1px solid ${palette.b}66;border-radius:12px">${esc(beat.label)}</span>`)
          .join('');
        content = `<div style="display:flex;flex-direction:column;gap:16px">${label('代码解读')}<h1 style="font-size:42px;color:#fff;margin:0">${title}</h1><div style="display:flex;flex-direction:column;gap:12px;padding:22px;border:1px solid ${palette.a}88;border-radius:18px;background:linear-gradient(145deg,${palette.bg},#0a1020)">${header ? `<div style="display:flex;align-items:center;gap:12px">${header}</div>` : ''}<pre style="margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre;overflow:hidden">${codeRows}</pre>${beatLabels ? `<div style="display:flex;flex-wrap:wrap;gap:10px">${beatLabels}</div>` : ''}</div></div>`;
        break;
      }
      content = `<div style="display:flex;flex-direction:column;gap:16px">${label('实现逻辑')}<h1 style="font-size:46px;color:#fff;margin:0">${title}</h1>${card(`<p style="font-size:25px;line-height:1.4;color:#fff;margin:0">${esc(scene.visual.explanation ?? scene.narration)}</p>${Array.isArray(scene.visual.steps) ? `<ol style="font-size:21px;line-height:1.45;color:#dbeafe">${scene.visual.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}`)}</div>`;
      break;
    }
    case 'timeline': { const items = Array.isArray(scene.visual.items) ? scene.visual.items : []; content = `<div style="display:flex;flex-direction:column;gap:18px">${label('发展脉络')}<h1 style="font-size:46px;color:#fff;margin:0">${title}</h1><div style="display:flex;gap:12px;flex-wrap:wrap">${items.map(item => { const point = item as { date?: unknown; label?: unknown }; return card(`${label(point.date)}${body(point.label)}`, `border-top:4px solid ${palette.a}`); }).join('')}</div></div>`; break; }
    case 'math': content = `<div style="display:flex;flex-direction:column;gap:18px">${label('公式拆解')}<h1 style="font-size:46px;color:#fff;margin:0">${title}</h1>${card(`<p class="${MATH_FORMULA_CLASS}" style="font-size:42px;font-weight:800;text-align:center;color:${palette.b};margin:12px 0">${esc(scene.visual.formula)}</p><p style="font-size:23px;line-height:1.4;color:#fff">${esc(scene.visual.explanation ?? scene.narration)}</p>`)}</div>`; break;
    case 'table': { const headers = Array.isArray(scene.visual.headers) ? scene.visual.headers : []; const rows = Array.isArray(scene.visual.rows) ? scene.visual.rows : []; content = `<div style="display:flex;flex-direction:column;gap:14px">${label('信息总览')}<h1 style="font-size:42px;color:#fff;margin:0">${title}</h1><table style="width:100%;border-collapse:collapse;color:#fff;font-size:20px"><thead><tr>${headers.map(h => `<th style="padding:12px;border:1px solid ${palette.a};background:${palette.bg};text-align:left">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row, ri) => `<tr>${(Array.isArray(row) ? row : []).map(cell => `<td style="padding:11px;border:1px solid #ffffff44;background:${ri % 2 ? '#151d32' : '#222b43'}">${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; break; }
    default: content = `<h1 style="font-size:48px;color:#fff">${title}</h1>${body(scene.narration)}`;
  }
  return `<div style="display:flex;flex-direction:column;justify-content:flex-start;gap:26px;box-sizing:border-box;width:100%;height:100%;padding:64px 76px;background:radial-gradient(circle at 90% 8%,${palette.a}88,transparent 35%),linear-gradient(135deg,${palette.bg},#090d1b)">${label(`知识拆解　✦　${String(index + 1).padStart(2, '0')}`)}${content}</div>`;
}

/** Fields the HTML layout is derived from; `visual.html` itself is excluded. */
function htmlSource(scene: Scene): string {
  const visual = { ...(scene.visual as Record<string, unknown>) };
  delete visual.html;
  return JSON.stringify([scene.type, scene.title ?? null, scene.narration, visual]);
}

/** The design index an existing layout was built with, read from its `知识拆解 ✦ NN` badge. */
export function sceneHtmlDesignIndex(html: string): number {
  const match = /知识拆解　✦　(\d+)/.exec(html);
  const value = match ? Number(match[1]) - 1 : 0;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * #203: an HTML-backed scene keeps its markup in `visual.html`, so a changed type, title, narration or
 * visual data left the preview and export showing the old layout. When a source field changed (and
 * the edit did not set the markup itself) the layout is rebuilt from the current data, keeping the
 * scene's original design.
 */
export function syncSceneHtml(previous: Scene, next: Scene): Scene {
  const html = next.visual.html;
  if (typeof html !== 'string' || next.type === 'media') return next;
  if (previous.visual.html !== html) return next;
  if (htmlSource(previous) === htmlSource(next)) return next;
  const index = sceneHtmlDesignIndex(typeof previous.visual.html === 'string' ? previous.visual.html : '');
  return { ...next, visual: { ...next.visual, html: sanitizeSceneHtml(structuredSceneHtml(next, index)) } };
}
