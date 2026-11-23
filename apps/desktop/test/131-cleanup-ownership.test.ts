/**
 * #131 / #132：Inno 测试清理只认本次运行创建的目录，不按进程名或路径片段误伤用户安装。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { makeTempRoot, cleanupRegisteredTempDirs, isOwnedTestPath, commandLineUsesOwnedPath } from './_helpers/temp';
import { createStagingDir, removeStagingDir } from './_helpers/gui';

test.after(() => cleanupRegisteredTempDirs());

test('[#131] 只把本次运行创建的目录及其子路径视为测试路径', () => {
  const root = makeTempRoot('ownership');
  assert.equal(isOwnedTestPath(root), true);
  assert.equal(isOwnedTestPath(path.join(root, '知影 安装 目录')), true);
  assert.equal(isOwnedTestPath(`${root}\\`), true);
  // 仅前缀相同的兄弟目录、包含 zhiying- 的真实安装、TEMP 下的其他软件都不算
  assert.equal(isOwnedTestPath(`${root}-sibling`), false);
  assert.equal(isOwnedTestPath('D:\\Zhiying-production'), false);
  assert.equal(isOwnedTestPath(path.join(os.tmpdir(), 'SomeOtherApp')), false);
  assert.equal(isOwnedTestPath(path.join(os.tmpdir(), 'zhiying-test-from-another-run')), false);
  assert.equal(isOwnedTestPath(''), false);
});

test('[#132] 只结束命令行指向本次 staging 目录的安装器', () => {
  const staging = createStagingDir('zhiying-test-ownership');
  try {
    const stagedExe = path.join(staging, 'Zhiying-Setup.exe');
    assert.equal(commandLineUsesOwnedPath(`"${stagedExe}" /VERYSILENT`), true);
    // Inno 的 is-*.tmp 子进程通过 /SL5 携带原 Setup.exe 路径
    assert.equal(commandLineUsesOwnedPath(`"C:\\Temp\\is-ABC.tmp\\Zhiying-Setup.tmp" /SL5="$1,2,3,${stagedExe}" /VERYSILENT`), true);
    const downloads = path.join(os.homedir(), 'Downloads', 'Zhiying-Setup.exe');
    assert.equal(commandLineUsesOwnedPath(`"${downloads}"`), false);
    assert.equal(commandLineUsesOwnedPath(`"${staging}-other\\Zhiying-Setup.exe"`), false);
  } finally {
    removeStagingDir(staging);
  }
});
