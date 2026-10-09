'use client';
import { useEffect, useState } from 'react';

type Settings = { configured: boolean; displayName: string; transcript: string; audioFilename: string };

export function GeneralSettings() {
  const [settings, setSettings] = useState<Settings>({ configured: false, displayName: '通用声音', transcript: '', audioFilename: '' });
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let stopped = false;
    void fetch('/api/settings/voice', { cache: 'no-store' }).then(response => response.json()).then(result => {
      if (!stopped) setSettings({ configured: Boolean(result.configured), displayName: result.displayName || '通用声音', transcript: result.transcript || '', audioFilename: result.audioFilename || '' });
    }).catch(() => { if (!stopped) setError('读取通用声音设置失败'); });
    return () => { stopped = true; };
  }, []);

  async function save() {
    if (!file && !settings.configured) { setError('首次配置通用声音时，请先选择参考音频'); return; }
    if (!settings.transcript.trim()) { setError('请填写参考音频对应的转录文本'); return; }
    setSaving(true); setError(''); setMessage('');
    try {
      const form = new FormData();
      if (file) form.set('audio', file);
      form.set('transcript', settings.transcript);
      form.set('displayName', settings.displayName);
      const response = await fetch('/api/settings/voice', { method: 'POST', body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '保存通用声音失败');
      setSettings(current => ({ ...current, configured: true, audioFilename: file?.name ?? current.audioFilename }));
      setFile(null);
      setMessage('通用声音已保存。未设置项目专属声音的项目会使用它。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存通用声音失败');
    } finally { setSaving(false); }
  }

  return <section className="settings-card general-settings-card"><p className="eyebrow">DEFAULT VOICE</p><h2>通用声音</h2><p className="muted">项目没有上传专属声音时，将使用这里的参考音频生成旁白。项目专属声音优先。</p><div className={`general-voice-status ${settings.configured ? 'configured' : ''}`}><i />{settings.configured ? `已配置：${settings.displayName || '通用声音'}` : '尚未配置通用声音'}</div><label className="field-label">声音名称</label><input className="input" maxLength={80} value={settings.displayName} onChange={event => setSettings(current => ({ ...current, displayName: event.target.value }))} /><label className="field-label">参考音频</label><label className="audio-picker"><input className="audio-file-input" type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a" onChange={event => setFile(event.currentTarget.files?.[0] ?? null)} /><span className="audio-picker-button">选择文件</span><span className="audio-filename">{file?.name ?? (settings.audioFilename || (settings.configured ? '选择新音频以替换当前通用声音' : '尚未选择参考音频'))}</span></label><label className="field-label">音频转录</label><p className="voice-transcript-hint">填写参考音频中实际说出的完整内容；生成语速由项目内的语速设置控制。</p><textarea className="input textarea" value={settings.transcript} onChange={event => setSettings(current => ({ ...current, transcript: event.target.value }))} placeholder="准确填写参考音频中说出的内容…" /><p className="hint">参考音频用于生成声音；文件保存在本机。</p>{error && <p className="error-box">{error}</p>}{message && <p className="settings-success">{message}</p>}<button className="button primary general-save-button" disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : settings.configured ? '更新通用声音' : '保存通用声音'}</button></section>;
}
