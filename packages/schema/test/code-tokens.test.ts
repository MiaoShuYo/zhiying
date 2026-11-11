import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearCodeTokenCache,
  codeLines,
  codeTokenCacheStats,
  plainCodeTokens,
  tokenizeCode,
  type CodeLineTokens,
  type CodeToken,
  type CodeTokenType,
} from '../src/index';

/**
 * #23 契约：确定性语法 tokenizer（doc/V1.6.9_issues.md §2.2）。
 * 覆盖 #23-1..6 的 token 类型/行结构不变量与 #23-10 的缓存/降级行为。
 */

const TOKEN_TYPES: CodeTokenType[] = ['plain', 'keyword', 'string', 'comment', 'number', 'function', 'variable', 'punctuation'];
const PUNCTUATION_CHARS = /^[{}[\]():;,.<>=+\-*/%!&|?]+$/;

const allTokens = (lines: CodeLineTokens[]): CodeToken[] => lines.flatMap(line => line.tokens);
const joinTokens = (tokens: CodeToken[]): string => tokens.map(token => token.text).join('');
const textsOfType = (lines: CodeLineTokens[], type: CodeTokenType): string[] =>
  allTokens(lines).filter(token => token.type === type).map(token => token.text);
const typeOfText = (lines: CodeLineTokens[], text: string): CodeTokenType[] =>
  allTokens(lines).filter(token => token.text === text).map(token => token.type);

/** 每行行号连续、token 拼接逐字等于原文、token 不含换行、类型合法；空行 tokens 为空数组。 */
function assertLineStructure(code: string, lines: CodeLineTokens[], label: string): void {
  const source = codeLines(code);
  assert.equal(lines.length, source.length, `${label}: 行数必须与 codeLines(code) 一致`);
  lines.forEach((line, index) => {
    assert.equal(line.lineNumber, index + 1, `${label}: 第 ${index + 1} 行 lineNumber 应为 ${index + 1}`);
    assert.equal(joinTokens(line.tokens), source[index], `${label}: 第 ${index + 1} 行 token 拼接必须逐字等于原文`);
    for (const token of line.tokens) {
      assert.equal(typeof token.text, 'string', `${label}: token.text 必须是字符串`);
      assert.equal(token.text.includes('\n') || token.text.includes('\r'), false, `${label}: token 文本不得包含换行：${JSON.stringify(token.text)}`);
      assert.ok(TOKEN_TYPES.includes(token.type), `${label}: token 类型 ${String(token.type)} 必须属于固定 8 类`);
    }
    if (source[index] === '') assert.deepEqual(line.tokens, [], `${label}: 空行 tokens 必须为空数组`);
  });
}

// ═════════════════════════════ #23-1 TypeScript ═════════════════════════════

const TS_CODE = [
  '// 读取缓存',
  'const cache = new Map();',
  'function getUser(id: number): string {',
  '  if (cache.has(id)) {',
  '    return cache.get(id);',
  '  }',
  '  const count = 42;',
  '  return `user-${id}-${count}`;',
  '  return fetchUser(id);',
  '}',
].join('\n');

test('#23-1 TypeScript token 类型：keyword/string/comment/number/function/variable/punctuation 可辨认且文本逐字一致', () => {
  clearCodeTokenCache();
  const lines = tokenizeCode(TS_CODE, 'typescript');
  assertLineStructure(TS_CODE, lines, 'TS');

  // keyword：语言关键字
  const keywords = textsOfType(lines, 'keyword');
  for (const keyword of ['const', 'function', 'if', 'return']) {
    assert.ok(keywords.includes(keyword), `关键字 ${keyword} 应被标记为 keyword，实际关键字：${keywords.join(',')}`);
  }
  // comment：// 行注释（含整段注释文本）
  const comments = textsOfType(lines, 'comment');
  assert.ok(comments.some(comment => comment.includes('//') && comment.includes('读取缓存')), `// 注释应为 comment：${comments.join(' | ')}`);
  // number：十进制数字
  assert.ok(textsOfType(lines, 'number').includes('42'), `42 应为 number：${textsOfType(lines, 'number').join(',')}`);
  // string：模板字符串（含逐字文本）
  const strings = textsOfType(lines, 'string');
  assert.ok(strings.some(text => text.includes('user-')), `模板字符串应为 string：${strings.join(' | ')}`);
  assert.ok(strings.some(text => text.includes('`')), '模板字符串 token 应包含反引号');
  // function：function 后的函数名以及标识符 + ( 的调用名
  const functions = textsOfType(lines, 'function');
  for (const name of ['getUser', 'fetchUser']) {
    assert.ok(functions.includes(name), `${name} 应为 function，实际 function：${functions.join(',')}`);
  }
  // variable：其余普通标识符
  const variables = textsOfType(lines, 'variable');
  for (const name of ['cache', 'id']) {
    assert.ok(variables.includes(name), `${name} 应为 variable，实际 variable：${variables.join(',')}`);
  }
  // punctuation：符号，且只包含契约列出的符号字符
  const punctuation = textsOfType(lines, 'punctuation');
  assert.ok(punctuation.length > 0, '应存在 punctuation token');
  for (const text of punctuation) assert.match(text, PUNCTUATION_CHARS, `punctuation token 只允许契约符号：${JSON.stringify(text)}`);
  const punctuationJoined = punctuation.join('');
  for (const symbol of ['=', '(', ')', '{', '}', ';', ':']) {
    assert.ok(punctuationJoined.includes(symbol), `标点 ${symbol} 应出现在 punctuation 中：${punctuationJoined}`);
  }
});

// ═════════════════════════════ #23-2 JavaScript ═════════════════════════════

const JS_CODE = [
  '// 加载数据',
  'let total = 0;',
  'const items = [1, 2, 3];',
  'async function load() {',
  "  const name = 'demo';",
  '  await fetch(`/api/${name}`);',
  '  return items.map(item => item * 2);',
  '}',
].join('\n');

test('#23-2 JavaScript token 类型：关键字/模板字符串/注释/数字/函数调用/变量/标点可辨认', () => {
  clearCodeTokenCache();
  const lines = tokenizeCode(JS_CODE, 'javascript');
  assertLineStructure(JS_CODE, lines, 'JS');

  const keywords = textsOfType(lines, 'keyword');
  for (const keyword of ['let', 'const', 'async', 'function', 'await', 'return']) {
    assert.ok(keywords.includes(keyword), `关键字 ${keyword} 应为 keyword，实际：${keywords.join(',')}`);
  }
  const comments = textsOfType(lines, 'comment');
  assert.ok(comments.some(comment => comment.includes('//')), `// 注释应为 comment：${comments.join(' | ')}`);
  for (const number of ['0', '1', '2', '3']) {
    assert.ok(textsOfType(lines, 'number').includes(number), `${number} 应为 number：${textsOfType(lines, 'number').join(',')}`);
  }
  const strings = textsOfType(lines, 'string');
  assert.ok(strings.some(text => text === "'demo'"), `单引号字符串应为 string：${strings.join(' | ')}`);
  assert.ok(strings.some(text => text.includes('/api/')), `模板字符串应为 string：${strings.join(' | ')}`);
  const functions = textsOfType(lines, 'function');
  for (const name of ['load', 'fetch']) {
    assert.ok(functions.includes(name), `${name} 应为 function，实际：${functions.join(',')}`);
  }
  const variables = textsOfType(lines, 'variable');
  for (const name of ['items', 'name']) {
    assert.ok(variables.includes(name), `${name} 应为 variable，实际：${variables.join(',')}`);
  }
  assert.ok(textsOfType(lines, 'punctuation').join('').includes('['), '数组方括号应为 punctuation');
});

// ═════════════════════════════ #23-3 Python ═════════════════════════════

const PY_CODE = [
  '# 问候函数',
  'def greet(name):',
  '    """Return a greeting."""',
  '    if name is None:',
  '        return "hello"',
  '    count = 3.14',
  '    return f"hi {name}"',
].join('\n');

test('#23-3 Python token 类型：# 注释、三引号字符串、def/class 名、关键字与数字可辨认', () => {
  clearCodeTokenCache();
  const lines = tokenizeCode(PY_CODE, 'python');
  assertLineStructure(PY_CODE, lines, 'Python');

  const keywords = textsOfType(lines, 'keyword');
  for (const keyword of ['def', 'if', 'is', 'None', 'return']) {
    assert.ok(keywords.includes(keyword), `Python 关键字 ${keyword} 应为 keyword，实际：${keywords.join(',')}`);
  }
  const comments = textsOfType(lines, 'comment');
  assert.ok(comments.some(comment => comment.includes('#') && comment.includes('问候函数')), `# 注释应为 comment：${comments.join(' | ')}`);
  const strings = textsOfType(lines, 'string');
  assert.ok(strings.some(text => text.includes('"""')), `三引号字符串应为 string：${strings.join(' | ')}`);
  assert.ok(strings.some(text => text.includes('"hello"')), `普通字符串应为 string：${strings.join(' | ')}`);
  assert.ok(textsOfType(lines, 'number').includes('3.14'), `3.14 应为 number：${textsOfType(lines, 'number').join(',')}`);
  const functions = textsOfType(lines, 'function');
  assert.ok(functions.includes('greet'), `def 后的函数名 greet 应为 function，实际：${functions.join(',')}`);
  const variables = textsOfType(lines, 'variable');
  for (const name of ['name', 'count']) {
    assert.ok(variables.includes(name), `${name} 应为 variable，实际：${variables.join(',')}`);
  }
  assert.ok(textsOfType(lines, 'punctuation').join('').includes(':'), '冒号应为 punctuation');
});

// ═════════════════════════════ #23-4 JSON ═════════════════════════════

const JSON_CODE = [
  '{',
  '  "name": "m2v",',
  '  "count": 42,',
  '  "ratio": 1.5,',
  '  "ok": true,',
  '  "flag": false,',
  '  "none": null,',
  '  "items": ["a", "b"]',
  '}',
].join('\n');

test('#23-4 JSON token 类型：字符串/数字/true-false-null/标点可辨认且逐字一致', () => {
  clearCodeTokenCache();
  const lines = tokenizeCode(JSON_CODE, 'json');
  assertLineStructure(JSON_CODE, lines, 'JSON');

  const strings = textsOfType(lines, 'string');
  for (const text of ['"name"', '"m2v"', '"items"', '"a"']) {
    assert.ok(strings.includes(text), `JSON 字符串 ${text} 应为 string，实际：${strings.join(' | ')}`);
  }
  const numbers = textsOfType(lines, 'number');
  for (const text of ['42', '1.5']) assert.ok(numbers.includes(text), `JSON 数字 ${text} 应为 number，实际：${numbers.join(',')}`);
  const keywords = textsOfType(lines, 'keyword');
  for (const literal of ['true', 'false', 'null']) {
    assert.ok(keywords.includes(literal), `JSON 字面量 ${literal} 应为 keyword，实际：${keywords.join(',')}`);
  }
  const punctuation = textsOfType(lines, 'punctuation').join('');
  for (const symbol of ['{', '}', '[', ']', ',', ':']) {
    assert.ok(punctuation.includes(symbol), `JSON 标点 ${symbol} 应出现在 punctuation 中：${punctuation}`);
  }
});

// ═════════════════════════════ #23-5 未知/缺省语言 fallback ═════════════════════════════

test('#23-5 未知/缺省/空语言回退纯文本 token 不抛错；语言名大小写归一', () => {
  clearCodeTokenCache();
  const code = 'const value = 1;';
  const plain = plainCodeTokens(code);
  // 纯文本 fallback 输出结构
  assert.deepEqual(tokenizeCode(code, 'rust'), plain, '未知语言必须与 plainCodeTokens 完全一致');
  for (const language of [undefined, '', 'unknown-lang', 'brainfuck', 'text']) {
    const lines = tokenizeCode(code, language);
    assert.deepEqual(lines, plain, `语言 ${String(language)} 必须回退纯文本`);
    assert.ok(allTokens(lines).every(token => token.type === 'plain'), `语言 ${String(language)} 回退后所有 token 均为 plain`);
  }
  // 大小写归一：同一语言的不同写法输出一致
  assert.deepEqual(tokenizeCode(TS_CODE, 'TypeScript'), tokenizeCode(TS_CODE, 'ts'), 'TypeScript/ts 归一');
  assert.deepEqual(tokenizeCode(TS_CODE, 'TYPESCRIPT'), tokenizeCode(TS_CODE, 'ts'), 'TYPESCRIPT/ts 归一');
  assert.deepEqual(tokenizeCode(TS_CODE, 'tsx'), tokenizeCode(TS_CODE, 'ts'), 'tsx/ts 归一');
  assert.deepEqual(tokenizeCode(JS_CODE, 'JavaScript'), tokenizeCode(JS_CODE, 'js'), 'JavaScript/js 归一');
  assert.deepEqual(tokenizeCode(JS_CODE, 'mjs'), tokenizeCode(JS_CODE, 'js'), 'mjs/js 归一');
  assert.deepEqual(tokenizeCode(PY_CODE, 'PY'), tokenizeCode(PY_CODE, 'python'), 'PY/python 归一');
  assert.deepEqual(tokenizeCode(JSON_CODE, 'JSON'), tokenizeCode(JSON_CODE, 'json'), 'JSON/json 归一');
  // 不抛错：异常输入安全降级
  assert.doesNotThrow(() => tokenizeCode(null as unknown as string, 'ts'), 'null code 不抛错');
  assert.doesNotThrow(() => tokenizeCode(undefined as unknown as string), 'undefined code 不抛错');
  assert.doesNotThrow(() => tokenizeCode(code, { bad: true } as unknown as string), '非法 language 不抛错');
});

// ═════════════════════════════ #23-6 行结构不变量 ═════════════════════════════

test('#23-6 行数=codeLines、token 拼接=原文、无换行 token、空行/空 code/CRLF/末尾换行安全', () => {
  clearCodeTokenCache();
  assert.deepEqual(tokenizeCode(''), [], '空 code → []');
  assert.deepEqual(tokenizeCode('', 'ts'), [], '空 code（指定语言）→ []');
  assert.equal(tokenizeCode('\r\n').length, codeLines('\r\n').length, '仅 CRLF 时行数与 codeLines 一致');

  const samples = [
    '',
    'single',
    'a\nb',
    'a\nb\n',
    '\n\na\n\n',
    'a = 1\r\nb = 2\r\n',
    'const t = `x`;\r\n// c\r\n42',
    'if (a < b && c > d) { return 1; }',
  ];
  for (const sample of samples) {
    const lines = tokenizeCode(sample, 'ts');
    assertLineStructure(sample, lines, `sample ${JSON.stringify(sample)}`);
    for (const line of lines) {
      for (const token of line.tokens) {
        assert.equal(/\r|\n/.test(token.text), false, 'token 文本不得包含 \\r/\\n');
      }
    }
  }
  // CRLF 被归一化：行文本与 codeLines 一致，不残留 \r
  const crlf = tokenizeCode('a = 1\r\nb = 2', 'ts');
  assert.deepEqual(crlf.map(line => joinTokens(line.tokens)), ['a = 1', 'b = 2']);
  assert.equal(crlf.some(line => line.tokens.some(token => token.text.includes('\r'))), false, 'CRLF 不进入 token');
  // 空行 tokens 为空数组
  const blank = tokenizeCode('a\n\nb', 'ts');
  assert.deepEqual(blank[1].tokens, []);
  // 末尾换行不新增空行
  assert.equal(tokenizeCode('a\nb\n', 'ts').length, 2);
});

// ═════════════════════════════ #23-6 极端规模（行数/长度/单行 token 密度）════════════════════════════════

/** 生成接近 target 字符数的多行代码（不超过 CodeVisualSchema 的 8000 字符上限）。 */
function codeNearLength(target: number): string {
  let code = '';
  let index = 0;
  while (true) {
    const line = `const value${index} = ${index} * 2 + 1;`;
    const next = code ? `${code}\n${line}` : line;
    if (next.length > target) return code;
    code = next;
    index += 1;
  }
}

/** 8000 字符单行、token 密度极高（约 6000 个 token）的源码。 */
const DENSE_SINGLE_LINE = `const dense = ${'a + '.repeat(1996)}1;`;

test('#23-6 极端规模：60/200 行、接近 8000 字符、8000 字符单行高 token 密度仍满足行结构不变量', () => {
  clearCodeTokenCache();
  const codeOf = (count: number) => Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');
  const fixtures = [
    { label: '60 行', code: codeOf(60) },
    { label: '200 行', code: codeOf(200) },
    { label: '接近 8000 字符（多行）', code: codeNearLength(7950) },
    { label: '8000 字符单行（高 token 密度）', code: DENSE_SINGLE_LINE },
  ];
  for (const { label, code } of fixtures) {
    assert.ok(code.length > 0 && code.length <= 8000, `${label}: 源码长度 ${code.length} 应 ≤ 8000`);
    const lines = tokenizeCode(code, 'typescript');
    assertLineStructure(code, lines, label);
    assert.equal(lines.length, codeLines(code).length, `${label}: 行数必须等于 codeLines 行数`);
    // 所有 token 文本总长 = 源码总长（无丢失/无新增）
    const joined = lines.map(line => joinTokens(line.tokens)).join('\n');
    assert.equal(joined, code, `${label}: 拼接结果必须逐字等于源码`);
  }
  const dense = tokenizeCode(DENSE_SINGLE_LINE, 'typescript');
  assert.equal(dense.length, 1, '8000 字符单行仍是 1 行');
  assert.equal(dense[0].tokens.length > 500, true, `高密度单行应产生大量 token，实际 ${dense[0].tokens.length}`);
  assert.equal(joinTokens(dense[0].tokens), DENSE_SINGLE_LINE, '高密度单行 token 拼接逐字一致');
  assert.equal(dense[0].tokens.some(token => token.text.includes('\n') || token.text.includes('\r')), false, '无换行 token');
});

// ═════════════════════════════ #23-10 缓存/性能/失败降级 ═════════════════════════════

test('#23-10 缓存命中/plain 不写缓存/不同 code·language 重新分词/容量 64 FIFO/多帧只 miss 一次', () => {
  clearCodeTokenCache();
  assert.deepEqual(codeTokenCacheStats(), { hits: 0, misses: 0, size: 0, capacity: 64 }, 'clear 后缓存为空且容量 64');

  const code = 'const value = 42;';
  tokenizeCode(code, 'ts');
  assert.deepEqual(codeTokenCacheStats(), { hits: 0, misses: 1, size: 1, capacity: 64 }, '首次 miss');
  tokenizeCode(code, 'ts');
  assert.deepEqual(codeTokenCacheStats(), { hits: 1, misses: 1, size: 1, capacity: 64 }, '重复调用 hit');
  // 归一化语言共享同一 key：ts 与 typescript 同一条缓存
  tokenizeCode(code, 'typescript');
  assert.equal(codeTokenCacheStats().hits, 2, 'ts/typescript 归一后共享缓存');
  assert.equal(codeTokenCacheStats().size, 1, '归一化语言不新增缓存项');

  // plainCodeTokens 不写缓存
  clearCodeTokenCache();
  plainCodeTokens(code);
  assert.deepEqual(codeTokenCacheStats(), { hits: 0, misses: 0, size: 0, capacity: 64 }, 'plainCodeTokens 不写缓存');

  // 不同 code / 不同 language 重新分词
  clearCodeTokenCache();
  tokenizeCode('const a = 1;', 'ts');
  tokenizeCode('const b = 2;', 'ts');
  tokenizeCode('const a = 1;', 'python');
  assert.deepEqual(codeTokenCacheStats(), { hits: 0, misses: 3, size: 3, capacity: 64 }, '不同 code/language 分别 miss');

  // 容量 64 + FIFO 淘汰
  clearCodeTokenCache();
  for (let index = 0; index < 64; index += 1) tokenizeCode(`const v${index} = ${index};`, 'ts');
  assert.equal(codeTokenCacheStats().size, 64, '装满 64 条');
  assert.equal(codeTokenCacheStats().misses, 64);
  tokenizeCode('const overflow = 1;', 'ts');
  const afterOverflow = codeTokenCacheStats();
  assert.equal(afterOverflow.size, 64, '第 65 条写入后容量仍为 64（FIFO 淘汰最旧）');
  assert.ok(afterOverflow.size <= afterOverflow.capacity, 'stats.size <= capacity 恒成立');
  // FIFO：最旧的第 0 条已被淘汰（再次分词必须 miss），最新的第 64 条仍命中
  tokenizeCode('const v0 = 0;', 'ts');
  assert.equal(codeTokenCacheStats().misses, afterOverflow.misses + 1, '被 FIFO 淘汰的最旧项再次分词应 miss');
  tokenizeCode('const overflow = 1;', 'ts');
  assert.equal(codeTokenCacheStats().hits, 1, '最近写入项仍命中');

  // 同一 scene 多帧/多渲染器只做一次完整分词（模拟逐帧调用）
  clearCodeTokenCache();
  for (let frame = 0; frame < 120; frame += 1) tokenizeCode(TS_CODE, 'typescript');
  const multiFrame = codeTokenCacheStats();
  assert.equal(multiFrame.misses, 1, '120 帧只 miss 1 次');
  assert.equal(multiFrame.hits, 119, '其余 119 帧命中');
  assert.equal(multiFrame.size, 1);

  // 失败降级：返回结构可消费、不阻断
  const degraded = tokenizeCode(null as unknown as string, 'ts');
  assert.ok(Array.isArray(degraded), '分词失败/非法输入仍返回数组');
  for (const line of degraded) {
    assert.ok(Array.isArray(line.tokens) && Number.isInteger(line.lineNumber), '降级结果结构合法');
  }
});
