'use client';

import { useEffect, useMemo, useState } from 'react';
import type { BrandKit } from '@m2v/schema';
import {
  brandDraftPayload,
  brandKitLimitMessage,
  defaultBrandDraft,
  draftFromKit,
  validateBrandKitDraft,
  type BrandKitDraft,
} from '@/lib/brand-kit-ui';
import { BrandKitDeleteDialog, BrandKitForm, BrandKitList } from './brand-kit-settings';

/**
 * 设置页“品牌套件”区域。
 *
 * 只管理全局品牌库（颜色 / 字体 / Logo），不涉及声音、字幕、BGM 或导出设置——
 * 那些属于 ProductionTemplate。交互状态集中在这里，列表/表单/确认框是纯展示组件，
 * 方便在没有 jsdom 的环境里做静态渲染测试。
 */

const DEFAULT_MAX = 30;

async function json(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `请求失败（${response.status}）`);
  return body as Record<string, unknown>;
}

export function BrandKits() {
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [max, setMax] = useState(DEFAULT_MAX);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<BrandKitDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [formError, setFormError] = useState('');
  const [formNotice, setFormNotice] = useState('');
  const [pendingLogoFile, setPendingLogoFile] = useState<File | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BrandKit | null>(null);
  const [deleteError, setDeleteError] = useState('');

  function applyList(result: Record<string, unknown>) {
    setKits(Array.isArray(result.brandKits) ? result.brandKits as BrandKit[] : []);
    setMax(Number(result.max) || DEFAULT_MAX);
  }

  useEffect(() => {
    let stopped = false;
    void fetch('/api/settings/brand-kits', { cache: 'no-store' })
      .then(response => json(response))
      .then(result => { if (!stopped) applyList(result); })
      .catch(error => { if (!stopped) setListError(error instanceof Error ? error.message : '读取品牌套件失败'); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, []);

  async function reload() {
    applyList(await json(await fetch('/api/settings/brand-kits', { cache: 'no-store' })));
  }

  const issues = useMemo(() => (draft ? validateBrandKitDraft(draft) : []), [draft]);

  function replaceKit(kit: BrandKit) {
    setKits(current => current.some(item => item.id === kit.id) ? current.map(item => (item.id === kit.id ? kit : item)) : [kit, ...current]);
  }

  function startCreate() {
    if (kits.length >= max) {
      setListError(brandKitLimitMessage(max));
      return;
    }
    setDraft(defaultBrandDraft());
    setEditingId(null);
    setPendingLogoFile(null);
    setFormError('');
    setFormNotice('');
    setListError('');
    setNotice('');
  }

  function startEdit(kit: BrandKit) {
    setDraft(draftFromKit(kit));
    setEditingId(kit.id);
    setPendingLogoFile(null);
    setFormError('');
    setFormNotice('');
    setNotice('');
  }

  function closeForm() {
    if (working) return;
    setDraft(null);
    setEditingId(null);
    setPendingLogoFile(null);
    setFormError('');
    setFormNotice('');
  }

  async function uploadLogo(brandKitId: string, file: File): Promise<BrandKit> {
    const form = new FormData();
    form.set('brandKitId', brandKitId);
    form.set('file', file);
    const result = await json(await fetch('/api/settings/brand-kits/logo', { method: 'POST', body: form }));
    return result.brandKit as BrandKit;
  }

  /**
   * Upload a Logo. When editing, the file lands immediately, but only the Logo fields
   * are merged back into the draft so unsaved color/font edits are never discarded.
   */
  async function selectLogo(file: File | null) {
    if (!file || !draft) return;
    if (!editingId) {
      setPendingLogoFile(file);
      setFormError('');
      setFormNotice(`已选择 Logo「${file.name}」，创建品牌套件后会一起上传。`);
      return;
    }
    setUploadingLogo(true);
    setFormError('');
    setFormNotice('');
    try {
      const kit = await uploadLogo(editingId, file);
      replaceKit(kit);
      // 只合并 Logo 路径，保留表单里尚未保存的 Logo 位置/尺寸等修改。
      setDraft(current => (current && kit.logo ? { ...current, logo: { ...current.logo, src: kit.logo.src } } : current));
      setFormNotice('Logo 已上传到品牌库；保存后其它字段也会更新。');
    } catch (error) {
      setFormError(error instanceof Error ? `Logo 上传失败：${error.message}` : 'Logo 上传失败');
    } finally {
      setUploadingLogo(false);
    }
  }

  async function save() {
    if (!draft || working) return;
    // Re-validate on submit: invalid hex must never reach the API.
    const payload = brandDraftPayload(draft);
    if (!payload.ok) {
      setFormError(payload.issues[0]?.message ?? '品牌套件内容无效');
      return;
    }
    setWorking(true);
    setFormError('');
    setFormNotice('');
    try {
      const result = editingId
        ? await json(await fetch('/api/settings/brand-kits', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: editingId, action: 'update', patch: payload.value }),
        }))
        : await json(await fetch('/api/settings/brand-kits', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload.value),
        }));
      let kit = result.brandKit as BrandKit;
      replaceKit(kit);
      let savedNotice = editingId ? `品牌套件「${kit.name}」已保存。` : `已创建品牌套件「${kit.name}」。`;
      if (pendingLogoFile) {
        try {
          kit = await uploadLogo(kit.id, pendingLogoFile);
          replaceKit(kit);
          setPendingLogoFile(null);
          savedNotice = `${savedNotice} Logo 已上传。`;
        } catch (uploadError) {
          // The kit itself is saved; keep editing it so the user can retry the Logo
          // without losing the fields that just landed.
          setEditingId(kit.id);
          setDraft(draftFromKit(kit));
          setFormError(`品牌套件已保存，但 Logo 上传失败：${uploadError instanceof Error ? uploadError.message : '未知错误'}。可重新选择 Logo 后再试。`);
          return;
        }
      }
      setEditingId(kit.id);
      setDraft(draftFromKit(kit));
      setFormNotice(savedNotice);
      setNotice(savedNotice);
      setListError('');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '保存品牌套件失败');
    } finally {
      setWorking(false);
    }
  }

  async function runAction(kit: BrandKit, action: 'duplicate' | 'default') {
    if (working) return;
    setWorking(true);
    setListError('');
    setNotice('');
    try {
      await json(await fetch('/api/settings/brand-kits', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: kit.id, action }),
      }));
      await reload();
      setNotice(action === 'duplicate' ? `已复制品牌套件「${kit.name}」。` : `已将「${kit.name}」设为默认品牌。`);
    } catch (error) {
      setListError(error instanceof Error ? error.message : '更新品牌套件失败');
    } finally {
      setWorking(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || working) return;
    setWorking(true);
    setDeleteError('');
    try {
      await json(await fetch(`/api/settings/brand-kits?id=${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' }));
      setKits(current => current.filter(kit => kit.id !== deleteTarget.id));
      if (editingId === deleteTarget.id) {
        setDraft(null);
        setEditingId(null);
      }
      setNotice(`已删除品牌套件「${deleteTarget.name}」。已应用到项目的品牌快照会继续保留。`);
      setDeleteTarget(null);
      setFormError('');
      setFormNotice('');
      // 默认项会转移到剩余品牌，重新读取以显示最新标记。
      await reload().catch(() => undefined);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除品牌套件失败');
    } finally {
      setWorking(false);
    }
  }

  return <section className="settings-card brand-kit-settings" id="brand-kits">
    {draft
      ? <BrandKitForm
        draft={draft}
        issues={issues}
        editingId={editingId}
        working={working}
        uploadingLogo={uploadingLogo}
        error={formError}
        notice={formNotice}
        pendingLogoName={pendingLogoFile?.name ?? ''}
        onChange={setDraft}
        onLogoFile={file => void selectLogo(file)}
        onSave={() => void save()}
        onCancel={closeForm}
      />
      : <BrandKitList
        kits={kits}
        max={max}
        loading={loading}
        working={working}
        error={listError}
        notice={notice}
        onStartCreate={startCreate}
        onEdit={startEdit}
        onDuplicate={kit => void runAction(kit, 'duplicate')}
        onSetDefault={kit => void runAction(kit, 'default')}
        onDelete={kit => { setDeleteTarget(kit); setDeleteError(''); }}
      />}
    {deleteTarget && <BrandKitDeleteDialog
      kit={deleteTarget}
      working={working}
      error={deleteError}
      onConfirm={() => void confirmDelete()}
      onCancel={() => { if (!working) { setDeleteTarget(null); setDeleteError(''); } }}
    />}
  </section>;
}
