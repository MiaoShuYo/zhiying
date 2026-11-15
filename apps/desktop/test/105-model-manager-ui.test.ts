/**
 * #105-19 模型管理器 UI（§2.5 ui/model-manager.ts）：
 * 自包含 HTML、目标路径、每模型名称/大小/状态/许可/操作按钮，动态文案转义无 XSS。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderModelManagerHtml } from '../src/ui/model-manager';

const HTML_PATH = path.resolve(import.meta.dirname, '..', 'src', 'ui', 'model-manager.ts');

test('[#105-19] 渲染自包含 HTML：目标路径、总进度、每模型卡片与操作按钮', () => {
  const html = renderModelManagerHtml();
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /保存位置/);
  assert.match(html, /id="target"/);
  assert.match(html, /id="overall-bar"/);
  assert.match(html, /id="overall-fill"/);
  assert.match(html, /id="models"/);
  assert.match(html, /可用空间/);
  // 每模型：名称/用途/大小/状态/已下载/进度/许可/安装路径
  for (const field of ['model-name', '用途：', '大小：', '状态：', '已下载：', '进度：', '许可：', '安装到：']) {
    assert.ok(html.includes(field), `UI 缺少模型字段：${field}`);
  }
  // 操作按钮覆盖各状态
  for (const action of ['开始下载', '暂停', '取消', '继续', '重试', '重新校验', '重新下载']) {
    assert.ok(html.includes(action), `UI 缺少操作按钮：${action}`);
  }
  // 状态中文标签齐全
  for (const label of ['未下载', '下载中', '已暂停', '校验中', '已安装', '失败', '已损坏']) {
    assert.ok(html.includes(label), `UI 缺少状态标签：${label}`);
  }
  // 许可提示（F5-TTS 非商业）
  assert.match(html, /CC BY-NC 4\.0/);
  assert.match(html, /禁止未授权商业使用/);
  // 自包含：无外部脚本/样式资源
  assert.ok(!/<script[^>]+src=/i.test(html), 'UI 不得引用外部脚本');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'UI 不得引用外部样式');
});

test('[#105-19] title 做 HTML 转义，注入脚本不能逃逸', () => {
  const malicious = '<img src=x onerror=alert(1)><script>alert("x")</script>';
  const html = renderModelManagerHtml({ title: malicious });
  assert.ok(!html.includes('<img src=x onerror'), 'title 未转义，存在 XSS 注入点');
  assert.ok(!html.includes('<script>alert("x")</script>'), 'title 未转义 script 标签');
  assert.ok(html.includes('&lt;img'), 'title 应被转义为 HTML 实体');
  assert.ok(html.includes('&amp;') || html.includes('&lt;script&gt;'), 'title 应被完整转义');
  // 默认标题
  assert.match(renderModelManagerHtml(), /<title>知影模型管理器<\/title>/);
  // 空标题回退
  assert.match(renderModelManagerHtml({ title: '   ' }), /知影模型管理器/);
});

test('[#105-19] 模型动态文案使用 textContent 注入（无 innerHTML XSS 通道）', () => {
  const source = fs.readFileSync(HTML_PATH, 'utf8');
  // 动态模型数据只能经 textContent / el() 注入
  assert.ok(source.includes('node.textContent = content'), '应使用 textContent 注入动态文案');
  assert.ok(!/innerHTML\s*=\s*(?!.*static)/.test(source), 'UI 不得使用 innerHTML 注入动态文案');
  assert.ok(!/insertAdjacentHTML/.test(source), 'UI 不得使用 insertAdjacentHTML');
  assert.ok(!/document\.write/.test(source), 'UI 不得使用 document.write');
  // 模型名称/许可说明等来自 API，均为 text()/el() 包装
  assert.match(source, /text\(model\.name/, '模型名称必须经 text() 安全包装');
  assert.match(source, /text\(model\.license\.notes\)/, '许可证说明必须经 text() 安全包装');
});
