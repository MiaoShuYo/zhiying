import type { DesktopModelStatusResult } from '@/lib/desktop-models';

const STATUS_LABELS: Record<string, string> = {
  not_installed: '未下载',
  downloading: '下载中',
  paused: '已暂停',
  verifying: '校验中',
  installed: '已安装',
  failed: '失败',
  corrupted: '已损坏',
};

const PURPOSE_LABELS: Record<string, string> = {
  llm: '本地大模型',
  tts: '语音合成',
  vocoder: '声码器',
  alignment: '字幕对齐',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${Math.round(value * 10) / 10} ${units[unit]}`;
}

function formatPercent(percent: number | undefined): string | undefined {
  return typeof percent === 'number' && Number.isFinite(percent) ? `${Math.round(percent * 10) / 10}%` : undefined;
}

/**
 * #105 D：「设置 → 模型」纯展示组件（props 注入，便于静态渲染测试）。
 */
export function DesktopModels({ status }: { status: DesktopModelStatusResult }) {
  if (!status.available) {
    return (
      <section className="settings-card">
        <p className="eyebrow">DESKTOP MODELS</p>
        <h2>模型管理</h2>
        <p className="muted">{status.reason ?? '未检测到知影安装版的模型目录。'}</p>
        <p className="hint">安装完成后可在模型管理器中选择“立即下载 AI 模型”或“稍后下载”，模型会保存在安装目录的 models 文件夹内。</p>
      </section>
    );
  }
  const percent = formatPercent(status.overall?.percent);
  return (
    <section className="settings-card">
      <p className="eyebrow">DESKTOP MODELS</p>
      <h2>模型管理</h2>
      <p className="muted">所有知影管理的模型（Ollama、F5-TTS、Vocos、字幕对齐）都保存在安装目录的 models 文件夹内。</p>
      <p className="model-location">
        保存位置：<code>{status.modelsRoot ?? '—'}</code>
      </p>
      <p className="muted">
        总体进度：{status.overall?.indeterminate || !percent ? '准备中 / 正在校验（进度不确定）' : percent}
        {status.overall ? `　已下载 ${formatBytes(status.overall.receivedBytes)} / ${status.overall.totalBytes > 0 ? formatBytes(status.overall.totalBytes) : '未知'}` : ''}
      </p>
      <table className="model-table">
        <thead>
          <tr>
            <th>模型</th>
            <th>用途</th>
            <th>大小</th>
            <th>状态</th>
            <th>许可</th>
          </tr>
        </thead>
        <tbody>
          {status.models.map(model => (
            <tr key={model.id}>
              <td>
                <strong>{model.name}</strong>
                {model.required ? <span className="muted">（必需）</span> : <span className="muted">（可选）</span>}
              </td>
              <td>{PURPOSE_LABELS[model.purpose] ?? model.purpose}</td>
              <td>{formatBytes(model.sizeBytes)}</td>
              <td>
                {STATUS_LABELS[model.status] ?? model.status}
                {formatPercent(model.percent) ? ` ${formatPercent(model.percent)}` : ''}
                {model.errorMessage ? <span className="muted">：{model.errorMessage}</span> : null}
              </td>
              <td>
                {model.licenseName}
                {model.commercialUse === 'restricted' ? '（非商业）' : model.commercialUse === 'unknown' ? '（商用待核实）' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        模型管理器是本地服务，只在 127.0.0.1 上监听。若链接无法打开，请先双击安装目录中的 Zhiying.exe 启动知影。
      </p>
      {status.managerUrl ? (
        <a className="button primary" href={status.managerUrl} target="_blank" rel="noreferrer">
          打开模型管理器
        </a>
      ) : null}
    </section>
  );
}
