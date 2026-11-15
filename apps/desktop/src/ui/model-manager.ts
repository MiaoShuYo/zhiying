/**
 * #105 模型管理器视图（自包含 HTML + 内联脚本，无外部资源）。
 *
 * 所有动态模型文案都通过 `textContent` 注入，服务端只对 title 做 HTML 转义，
 * 避免模型名称/许可说明造成 XSS。
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  not_installed: '未下载',
  downloading: '下载中',
  paused: '已暂停',
  verifying: '校验中',
  installed: '已安装',
  failed: '失败',
  corrupted: '已损坏',
};

const PURPOSE_LABELS: Readonly<Record<string, string>> = {
  llm: '本地大模型',
  tts: '语音合成',
  vocoder: '声码器',
  alignment: '字幕对齐',
};

/** 渲染模型管理器页面（title 会被 HTML 转义）。 */
export function renderModelManagerHtml(options: { title?: string } = {}): string {
  const title = escapeHtml(options.title?.trim() || '知影模型管理器');
  const statusLabelsJson = JSON.stringify(STATUS_LABELS);
  const purposeLabelsJson = JSON.stringify(PURPOSE_LABELS);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --card:#171a21; --line:#2a2f3a; --text:#e8eaed; --muted:#9aa4b2; --accent:#4f8cff; --ok:#2fbf71; --warn:#e0a800; --err:#e05252; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background:var(--bg); color:var(--text); }
  header { padding:20px 28px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 6px; font-size:20px; }
  .muted { color:var(--muted); font-size:13px; }
  main { padding:20px 28px 40px; max-width:1080px; margin:0 auto; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin-bottom:18px; }
  .target { font-family: ui-monospace, Consolas, monospace; word-break:break-all; }
  .progress { height:10px; background:#0b0d11; border-radius:999px; overflow:hidden; margin:10px 0 6px; }
  .progress > div { height:100%; width:0%; background:var(--accent); transition:width .2s ease; }
  .progress.indeterminate > div { width:35%; animation:slide 1.2s infinite ease-in-out; }
  @keyframes slide { 0% { margin-left:-35%; } 100% { margin-left:100%; } }
  .models { display:grid; gap:12px; }
  .model { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .model-head { display:flex; justify-content:space-between; gap:12px; align-items:baseline; flex-wrap:wrap; }
  .model-name { font-size:15px; font-weight:600; }
  .state { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); }
  .state.installed { color:var(--ok); border-color:var(--ok); }
  .state.downloading, .state.verifying { color:var(--accent); border-color:var(--accent); }
  .state.paused { color:var(--warn); border-color:var(--warn); }
  .state.failed, .state.corrupted { color:var(--err); border-color:var(--err); }
  .model-meta { color:var(--muted); font-size:12px; margin:6px 0; line-height:1.6; }
  .model-error { color:var(--err); font-size:12px; margin-top:6px; white-space:pre-wrap; }
  .actions { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:6px 12px; font-size:13px; cursor:pointer; }
  button.secondary { background:#242a35; color:var(--text); }
  button:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:16px; flex-wrap:wrap; align-items:baseline; }
  .summary { font-size:13px; color:var(--muted); }
  footer { padding:0 28px 30px; color:var(--muted); font-size:12px; max-width:1080px; margin:0 auto; }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <div class="muted">下载过程可暂停/恢复；所有模型与临时文件都保存在安装目录的 models 文件夹内。</div>
</header>
<main>
  <section class="panel">
    <div class="row">
      <div>保存位置：<span id="target" class="target">正在读取…</span></div>
      <div class="summary" id="disk"></div>
    </div>
    <div class="progress" id="overall-bar"><div id="overall-fill"></div></div>
    <div class="summary" id="overall-text">正在读取模型状态…</div>
  </section>
  <section class="models" id="models"></section>
</main>
<footer>模型由各自源站提供，请遵守模型许可（尤其 F5-TTS 为非商业 CC BY-NC 4.0）。关闭本窗口不会删除已下载文件。</footer>
<script>
(function () {
  'use strict';
  var STATUS_LABELS = ${statusLabelsJson};
  var PURPOSE_LABELS = ${purposeLabelsJson};
  var lastModels = [];
  var busy = {};

  function text(value) { return value === undefined || value === null ? '' : String(value); }
  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '未知';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var value = bytes;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return (unit === 0 ? Math.round(value) : Math.round(value * 10) / 10) + ' ' + units[unit];
  }
  function formatPercent(percent) { return typeof percent === 'number' && isFinite(percent) ? (Math.round(percent * 10) / 10) + '%' : undefined; }
  function formatSpeed(speed) { return typeof speed === 'number' && speed > 0 ? formatBytes(speed) + '/s' : undefined; }
  function formatEta(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds <= 0) return undefined;
    var minutes = Math.floor(seconds / 60);
    var rest = Math.round(seconds % 60);
    return minutes > 0 ? '约 ' + minutes + ' 分 ' + rest + ' 秒' : '约 ' + rest + ' 秒';
  }
  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = content;
    return node;
  }
  function statusLabel(status) { return STATUS_LABELS[status] || text(status); }
  function purposeLabel(purpose) { return PURPOSE_LABELS[purpose] || text(purpose); }

  function renderModels(models) {
    lastModels = models || [];
    var container = document.getElementById('models');
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!lastModels.length) { container.appendChild(el('p', 'muted', '清单为空。')); return; }
    for (var index = 0; index < lastModels.length; index += 1) {
      var model = lastModels[index] || {};
      var card = el('article', 'model');
      var head = el('div', 'model-head');
      head.appendChild(el('span', 'model-name', text(model.name || model.id)));
      head.appendChild(el('span', 'state ' + text(model.status), statusLabel(model.status)));
      card.appendChild(head);
      var meta = el('div', 'model-meta');
      meta.appendChild(el('div', '', '用途：' + purposeLabel(model.purpose) + (model.required ? '（必需）' : '（可选）')));
      meta.appendChild(el('div', '', '大小：' + formatBytes(model.sizeBytes) + '　状态：' + statusLabel(model.status)));
      var received = formatBytes(model.receivedBytes || 0);
      var total = formatBytes(model.totalBytes);
      meta.appendChild(el('div', '', '已下载：' + received + (model.totalBytes ? ' / ' + total : '（总量未知）')));
      var percent = formatPercent(model.percent);
      if (percent) meta.appendChild(el('div', '', '进度：' + percent));
      var speed = formatSpeed(model.speedBps);
      if (speed) meta.appendChild(el('div', '', '速度：' + speed + '（估算）'));
      var eta = formatEta(model.etaSeconds);
      if (eta) meta.appendChild(el('div', '', '预计剩余：' + eta + '（估算）'));
      if (model.license && model.license.name) {
        var licenseLine = '许可：' + text(model.license.name);
        if (model.license.commercialUse === 'restricted') licenseLine += '（禁止未授权商业使用）';
        else if (model.license.commercialUse === 'unknown') licenseLine += '（商用许可未知，请自行核实）';
        meta.appendChild(el('div', '', licenseLine));
        if (model.license.notes) meta.appendChild(el('div', '', text(model.license.notes)));
      }
      if (model.installPath) meta.appendChild(el('div', 'target', '安装到：' + text(model.installPath)));
      card.appendChild(meta);
      if (model.error && model.error.message) card.appendChild(el('div', 'model-error', text(model.error.message)));
      var actions = el('div', 'actions');
      function button(label, action, secondary, keepPartial) {
        var control = el('button', secondary ? 'secondary' : '', label);
        control.disabled = Boolean(busy[model.id]);
        control.addEventListener('click', function () { act(model.id, action, keepPartial); });
        actions.appendChild(control);
      }
      if (model.status === 'not_installed') button('开始下载', 'start', false);
      else if (model.status === 'downloading' || model.status === 'verifying') { button('暂停', 'pause', false); button('取消', 'cancel', true); }
      else if (model.status === 'paused') { button('继续', 'resume', false); button('取消', 'cancel', true); }
      else if (model.status === 'failed' || model.status === 'corrupted') { button('重试', 'retry', false); button('取消', 'cancel', true); }
      else if (model.status === 'installed') { button('重新校验', 'verify', true); button('重新下载', 'start', true); }
      if (actions.firstChild) card.appendChild(actions);
      container.appendChild(card);
    }
  }

  function renderOverall(payload) {
    var overall = payload.overall || {};
    var percent = formatPercent(overall.percent);
    var bar = document.getElementById('overall-bar');
    var fill = document.getElementById('overall-fill');
    if (typeof percent === 'string' && !overall.indeterminate) {
      bar.className = 'progress';
      fill.style.width = percent;
    } else {
      bar.className = 'progress indeterminate';
      fill.style.width = '35%';
    }
    var textNode = document.getElementById('overall-text');
    var summary = '总进度：' + (percent ? percent + '（估算）' : '准备中 / 正在校验（进度不确定）');
    summary += '　已完成 ' + formatBytes(overall.receivedBytes || 0) + ' / ' + (overall.totalBytes ? formatBytes(overall.totalBytes) : '未知');
    textNode.textContent = summary;
  }

  function render(payload) {
    if (!payload) return;
    if (payload.modelsRoot) document.getElementById('target').textContent = text(payload.modelsRoot);
    if (payload.disk) {
      document.getElementById('disk').textContent = '可用空间：' + formatBytes(payload.disk.freeBytes) + (payload.disk.writable ? '' : '（目录不可写）');
    }
    renderOverall(payload);
    renderModels(payload.models || []);
  }

  function refresh() {
    return fetch('/api/models', { cache: 'no-store' }).then(function (response) { return response.json(); }).then(render).catch(function () {});
  }

  function act(id, action, keepPartial) {
    busy[id] = true;
    var options = { method: 'POST', headers: { 'content-type': 'application/json' } };
    if (action === 'cancel') options.body = JSON.stringify({ keepPartial: keepPartial !== false });
    fetch('/api/models/' + encodeURIComponent(id) + '/' + action, options)
      .then(function () { return refresh(); })
      .catch(function () {})
      .then(function () { busy[id] = false; });
  }

  refresh();
  if (window.EventSource) {
    var source = new EventSource('/api/events');
    source.addEventListener('progress', function (event) {
      try { render(JSON.parse(event.data)); } catch (error) { /* 忽略非法事件 */ }
    });
  } else {
    setInterval(refresh, 2000);
  }
})();
</script>
</body>
</html>
`;
}
