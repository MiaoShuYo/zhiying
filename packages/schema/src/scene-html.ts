/**
 * Inert-presentation HTML sanitizer.
 *
 * Generated scene markup (and the HTML-mode CodeScene renderer) may only contribute static
 * presentation: a small tag whitelist, `class` plus a validated inline `style`. Nothing here can
 * execute script, load a remote resource or escape the style attribute, so the result is safe for
 * `dangerouslySetInnerHTML`.
 *
 * Style handling is intentionally *per property*: code layout needs a handful of properties
 * (`transform`, `overflow-x/y`, `font-family`, …) that a single generic character whitelist would
 * either block or over-open (`transform:url(...)`), so those properties get dedicated parsers.
 * Everything else keeps the original conservative character whitelist.
 */

const MAX_HTML_LENGTH = 20000;
const MAX_DECLARATION_LENGTH = 100;
const MAX_FONT_FAMILY_LENGTH = 120;
const MAX_TRANSFORM_LENGTH = 100;
const MAX_TRANSFORM_ORIGIN_LENGTH = 40;

const REMOVED_TAGS = 'script|style|iframe|object|embed|form|video|audio|svg|math';

const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'br', 'hr', 'pre', 'code',
]);

/** Every style property that may appear in the sanitized output. */
const ALLOWED_PROPERTIES = new Set([
  'color', 'background', 'background-color', 'font-size', 'font-weight', 'text-align', 'line-height',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-left',
  'border', 'border-top', 'border-radius', 'display', 'flex', 'flex-direction', 'flex-wrap', 'gap',
  'align-items', 'justify-content', 'width', 'min-width', 'max-width', 'height', 'min-height',
  'grid-template-columns', 'box-shadow', 'box-sizing', 'border-collapse', 'font-family',
  'white-space', 'opacity', 'overflow', 'overflow-x', 'overflow-y', 'letter-spacing',
  'text-overflow', 'transform', 'transform-origin',
]);

const OVERFLOW_VALUES = new Set(['visible', 'hidden', 'auto', 'scroll', 'clip']);
const WHITE_SPACE_VALUES = new Set(['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']);

/** Values that must never reach a browser style attribute, whatever the property is. */
const DANGEROUS_STYLE_VALUE = /url\s*\(|expression\s*\(|@import|javascript\s*:|vbscript\s*:|data\s*:|-moz-binding|behavior\s*:|\\|[<>]|[\u0000-\u001f\u007f]/i;

/** The original conservative value whitelist kept for every non-code property. */
const GENERIC_STYLE_VALUE = /^[\w\s#(),.%/-]+$/;

/** Letters/digits/space/underscore/hyphen/quotes/comma/Chinese only; no parentheses or escapes. */
const FONT_FAMILY_VALUE = /^[A-Za-z0-9 _\-\u3400-\u9fff'",，]+$/;

const TRANSFORM_FUNCTIONS = new Set(['translate', 'translateX', 'translateY', 'scale', 'scaleX', 'scaleY']);
const TRANSLATE_ARGUMENT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|%)?$/;
const SCALE_ARGUMENT = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;
const TRANSFORM_ORIGIN_TOKEN = /^(?:left|right|top|bottom|center|-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|%))$/;

/** Port of the previous sanitizer for values that do not need a dedicated parser. */
function sanitizeGenericDeclaration(property: string, value: string): string | null {
  if (!ALLOWED_PROPERTIES.has(property)) return null;
  return GENERIC_STYLE_VALUE.test(value) ? `${property}:${value}` : null;
}

/** `font-family` only allows local font names; double quotes are entity-escaped for the attribute. */
function sanitizeFontFamily(value: string): string | null {
  if (value.length > MAX_FONT_FAMILY_LENGTH) return null;
  if (!FONT_FAMILY_VALUE.test(value)) return null;
  if (/url/i.test(value)) return null;
  return `font-family:${value.replace(/"/g, '&quot;')}`;
}

/**
 * `transform` accepts at most three `translate*`/`scale*` functions with plain numeric arguments.
 * The whole value is consumed by the parser, so nesting (`translate(calc(...))`), compound
 * transforms (`matrix`, `rotate`, `skew`, `perspective`) and trailing junk are all rejected.
 */
function sanitizeTransform(value: string): string | null {
  if (!value || value.length > MAX_TRANSFORM_LENGTH) return null;
  if (/url|expression|calc|var|matrix|rotate|skew|perspective/i.test(value)) return null;
  let rest = value.trim();
  let functions = 0;
  while (rest.length) {
    const match = /^([a-zA-Z]+)\(([^()]*)\)/.exec(rest);
    if (!match) return null;
    const name = match[1];
    if (!TRANSFORM_FUNCTIONS.has(name)) return null;
    const rawArguments = match[2].trim();
    if (rawArguments.includes('(') || rawArguments.includes(')')) return null;
    // CSS accepts comma-separated arguments; whitespace-separated arguments are also common in
    // hand-written code layout styles, so both separators are accepted with the same 1–2 arity.
    const args = rawArguments.split(/[\s,]+/).filter(Boolean);
    if (!args.length || args.length > 2) return null;
    const argumentPattern = name.startsWith('translate') ? TRANSLATE_ARGUMENT : SCALE_ARGUMENT;
    if (!args.every(arg => argumentPattern.test(arg))) return null;
    functions += 1;
    if (functions > 3) return null;
    rest = rest.slice(match[0].length).replace(/^\s+/, '');
  }
  return functions >= 1 ? `transform:${value.trim()}` : null;
}

/** `transform-origin` accepts one or two keyword/length tokens only. */
function sanitizeTransformOrigin(value: string): string | null {
  if (!value || value.length > MAX_TRANSFORM_ORIGIN_LENGTH) return null;
  const tokens = value.trim().split(/\s+/);
  if (tokens.length < 1 || tokens.length > 2) return null;
  if (!tokens.every(token => TRANSFORM_ORIGIN_TOKEN.test(token))) return null;
  return `transform-origin:${tokens.join(' ')}`;
}

function sanitizeOpacity(value: string): string | null {
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? `opacity:${value}` : null;
}

/** One validated `property:value` declaration, or null when the declaration must be dropped. */
function sanitizeDeclaration(property: string, value: string): string | null {
  if (!value) return null;
  if (DANGEROUS_STYLE_VALUE.test(value)) return null;
  switch (property) {
    case 'font-family': return sanitizeFontFamily(value);
    case 'transform': return sanitizeTransform(value);
    case 'transform-origin': return sanitizeTransformOrigin(value);
    case 'overflow':
    case 'overflow-x':
    case 'overflow-y': return OVERFLOW_VALUES.has(value) ? `${property}:${value}` : null;
    case 'opacity': return sanitizeOpacity(value);
    case 'white-space': return WHITE_SPACE_VALUES.has(value) ? `${property}:${value}` : null;
    default:
      // Every other property keeps the original conservative character whitelist and 100 char cap.
      if (value.length > MAX_DECLARATION_LENGTH) return null;
      return sanitizeGenericDeclaration(property, value);
  }
}

/** Build the safe `style="…"` value for one tag, preserving declaration order. */
function sanitizeStyleAttribute(style: string): string | null {
  const declarations = style.split(';').flatMap(rule => {
    const colon = rule.indexOf(':');
    if (colon < 1) return [];
    const property = rule.slice(0, colon).trim().toLowerCase();
    const value = rule.slice(colon + 1).trim();
    const declaration = sanitizeDeclaration(property, value);
    return declaration ? [declaration] : [];
  });
  return declarations.length ? declarations.join(';') : null;
}

/**
 * Restrict generated scene markup to inert presentation HTML and inline styles.
 *
 * Tags and attributes are rebuilt from scratch (only `class` and a validated `style` survive), the
 * dangerous element list is stripped together with its content, and the input is truncated to
 * 20000 characters so a generated scene can never grow without bound.
 */
export function sanitizeSceneHtml(input: string): string {
  if (typeof input !== 'string' || !input) return '';
  let html = input.slice(0, MAX_HTML_LENGTH)
    .replace(new RegExp(`<(${REMOVED_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '')
    .replace(new RegExp(`<(${REMOVED_TAGS})\\b[^>]*\\/?>`, 'gi'), '');
  html = html.replace(/<\/?([a-z][a-z0-9-]*)\b([^>]*)>/gi, (whole: string, rawName: string, rawAttrs: string) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    if (whole.startsWith('</')) return `</${name}>`;
    const attrs: string[] = [];
    const className = /\bclass\s*=\s*(["'])(.*?)\1/i.exec(rawAttrs)?.[2];
    if (className && /^[\w\s-]{1,120}$/.test(className)) attrs.push(`class="${className}"`);
    const style = /\bstyle\s*=\s*(["'])(.*?)\1/i.exec(rawAttrs)?.[2];
    if (style) {
      const sanitized = sanitizeStyleAttribute(style);
      if (sanitized) attrs.push(`style="${sanitized}"`);
    }
    return `<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  });
  return html;
}
