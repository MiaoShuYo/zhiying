/**
 * Windows 注册表 / 桌面快捷方式助手：
 * - 读取、备份、清理 HKCU 卸载项（真实写注册表测试后可完整恢复）；
 * - 桌面 .lnk 检查。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zhiying';
export const UNINSTALL_KEY_PS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zhiying';

export interface RegistryValue {
  type: string;
  value: string;
}

function runReg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** 通过 PowerShell（UTF-8 输出）读取注册表，避免 reg.exe 在非 UTF-8 代码页下把中文值读成乱码。 */
function runPowerShellJson(script: string): unknown {
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
  );
  const text = (res.stdout ?? '').trim();
  if (!text || text === 'null') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function keyExists(keyPath = UNINSTALL_KEY): boolean {
  const res = runReg(['query', keyPath]);
  return res.status === 0;
}

/** 读取注册表键的所有值；键不存在返回 null。 */
export function readRegistryValues(keyPath = UNINSTALL_KEY): Record<string, RegistryValue> | null {
  const psPath = keyPath.replace(/^HKCU\\/i, 'HKCU:\\').replace(/^HKLM\\/i, 'HKLM:\\');
  const script = [
    `$key='${psPath.replace(/'/g, "''")}';`,
    'if (Test-Path $key) {',
    '  $props = Get-ItemProperty -Path $key;',
    '  $items = @();',
    '  foreach ($prop in $props.PSObject.Properties) {',
    "    if ($prop.Name -like 'PS*') { continue }",
    "    $items += [pscustomobject]@{ name = $prop.Name; type = 'REG_SZ'; value = [string]$prop.Value }",
    '  }',
    "  ConvertTo-Json -InputObject @($items) -Compress",
    '} else {',
    "  'null'",
    '}',
  ].join(' ');
  const parsed = runPowerShellJson(script);
  if (!Array.isArray(parsed)) return null;
  const values: Record<string, RegistryValue> = {};
  for (const item of parsed as Array<{ name?: string; type?: string; value?: string }>) {
    if (!item || typeof item.name !== 'string') continue;
    values[item.name] = { type: item.type ?? 'REG_SZ', value: item.value ?? '' };
  }
  return values;
}

export function readRegistryValue(name: string, keyPath = UNINSTALL_KEY): string | null {
  const values = readRegistryValues(keyPath);
  if (!values) return null;
  return values[name]?.value ?? null;
}

export function deleteRegistryKey(keyPath = UNINSTALL_KEY): void {
  runReg(['delete', keyPath, '/f']);
}

/** 备份一个可能已存在的键（相同值集），返回恢复函数。 */
export function snapshotAndGuardRegistryKey(keyPath = UNINSTALL_KEY): { restore: () => void; existed: boolean; values: Record<string, RegistryValue> | null } {
  const existed = keyExists(keyPath);
  const values = existed ? readRegistryValues(keyPath) : null;
  return {
    existed,
    values,
    restore: () => {
      try {
        deleteRegistryKey(keyPath);
        if (existed && values) {
          for (const [name, v] of Object.entries(values)) {
            runReg(['add', keyPath, '/v', name || '(Default)', '/t', v.type, '/d', v.value, '/f']);
          }
        }
      } catch {
        /* 清理尽力而为 */
      }
    },
  };
}

/** 测试文件 after() 用：先删除本次测试键，再恢复测试前原始状态。 */
export function registerRegistryCleanup(t: { after(fn: () => void): void }, keyPath = UNINSTALL_KEY): void {
  const guard = snapshotAndGuardRegistryKey(keyPath);
  t.after(() => {
    deleteRegistryKey(keyPath);
    guard.restore();
  });
}

/** 当前用户桌面目录（不依赖 WScript，安装器自己会经 WScript 解析，这里用标准路径校验）。 */
export function desktopDirs(): string[] {
  const candidates = [path.join(process.env.USERPROFILE ?? '', 'Desktop'), path.join(process.env.USERPROFILE ?? '', 'OneDrive', 'Desktop')];
  return candidates.filter((p) => p && fs.existsSync(p));
}

/** 查找桌面上的 Zhiying 快捷方式（.lnk）。 */
export function findZhiyingShortcut(): string | null {
  for (const dir of desktopDirs()) {
    for (const name of ['知影.lnk', 'Zhiying.lnk', '知影 Zhiying.lnk']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (/zhiying|知影/i.test(entry) && entry.toLowerCase().endsWith('.lnk')) return path.join(dir, entry);
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 测试后清理测试创建的快捷方式（只删除本次测试记录到的路径）。 */
export function deleteShortcutIfExists(p: string | null): void {
  if (!p) return;
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}
