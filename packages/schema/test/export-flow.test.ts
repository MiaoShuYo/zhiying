import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFlow, type ExportFlowInput, type ExportFlowJob } from '../src/index';

const job = (patch: Partial<ExportFlowJob> = {}): ExportFlowJob => ({
  id: 'job-1', status: 'completed', stage: 'done', updatedAt: '2025-01-01T00:00:00.000Z', hasValidation: true, videoState: 'current', ...patch,
});
const input = (patch: Partial<ExportFlowInput> = {}): ExportFlowInput => ({ blocking: 0, checkedRevision: 3, revision: 3, job: null, delivery: null, ...patch });
const states = (flow: ReturnType<typeof exportFlow>) => flow.steps.map(step => step.state);

test('有阻断问题时第一步就停下，后续记录不再冒充已通过', () => {
  const flow = exportFlow(input({ blocking: 2, job: job(), delivery: { status: 'ready', at: '2025-01-02T00:00:00.000Z' } }));
  assert.equal(flow.steps[0].state, 'blocked');
  assert.equal(flow.canExport, false);
  assert.equal(flow.resumeFrom, 'preflight');
  assert.deepEqual(flow.passed, []);
  assert.match(flow.headline, /先处理 2 项阻断问题/);
  assert.equal(flow.steps[3].state, 'pending', '打包记录属于上一次导出，不能沿用');
});

test('从未检查过的项目提示先去检查', () => {
  const flow = exportFlow(input({ checkedRevision: null }));
  assert.equal(flow.steps[0].state, 'pending');
  assert.match(flow.steps[0].message, /还没有通过导出前检查/);
  assert.equal(flow.canExport, false);
});

test('分镜改过之后上一次的检查结论失效', () => {
  const flow = exportFlow(input({ revision: 4 }));
  assert.equal(flow.steps[0].state, 'pending');
  assert.match(flow.steps[0].message, /分镜已修改，需要重新检查/);
  assert.equal(flow.canExport, false);
});

test('检查通过后从渲染继续，并说明不会重做检查', () => {
  const flow = exportFlow(input());
  assert.equal(flow.steps[0].state, 'passed');
  assert.equal(flow.canExport, true);
  assert.equal(flow.resumeFrom, 'render');
  assert.deepEqual(flow.passed, ['preflight']);
  assert.match(flow.headline, /第 2 步（渲染）/);
  assert.match(flow.headline, /已通过的检查不会重做/);
});

test('渲染失败保留失败原因，校验与打包退回到待完成', () => {
  const flow = exportFlow(input({ job: job({ status: 'failed', error: 'ffmpeg 退出码 1', videoState: 'missing', hasValidation: true }) }));
  assert.equal(flow.steps[1].state, 'failed');
  assert.equal(flow.steps[1].message, 'ffmpeg 退出码 1');
  assert.equal(flow.steps[2].state, 'pending');
  assert.equal(flow.resumeFrom, 'render');
  assert.match(flow.headline, /第 2 步（渲染）失败/);
});

test('导出中显示阶段，并说明完成后会自动校验', () => {
  const flow = exportFlow(input({ job: job({ status: 'running', stage: 'encoding', videoState: 'missing', hasValidation: false }) }));
  assert.equal(flow.steps[1].state, 'running');
  assert.match(flow.steps[1].message, /正在/);
  assert.equal(flow.resumeFrom, 'render');
  assert.match(flow.headline, /正在导出成片/);
});

test('成片被后续导出覆盖或文件丢失都要重新渲染', () => {
  const superseded = exportFlow(input({ job: job({ videoState: 'superseded' }) }));
  assert.equal(superseded.steps[1].state, 'failed');
  assert.match(superseded.steps[1].message, /覆盖/);
  const missing = exportFlow(input({ job: job({ videoState: 'missing' }) }));
  assert.equal(missing.steps[1].state, 'failed');
  assert.match(missing.steps[1].message, /已不存在/);
  assert.equal(missing.steps[2].state, 'failed', '成片不可用就没有可校验的对象');
});

test('四个步骤都通过时没有可继续的步骤', () => {
  const flow = exportFlow(input({ job: job(), delivery: { status: 'ready', at: '2025-01-02T00:00:00.000Z' } }));
  assert.deepEqual(states(flow), ['passed', 'passed', 'passed', 'passed']);
  assert.equal(flow.resumeFrom, null);
  assert.equal(flow.headline, '四个步骤都已通过，可以交付。');
});

test('没有校验的成片停在第三步，打包失败要给出原因', () => {
  const unvalidated = exportFlow(input({ job: job({ hasValidation: false }), delivery: { status: 'failed', message: '压缩包缺少清单' } }));
  assert.equal(unvalidated.steps[2].state, 'pending');
  assert.equal(unvalidated.resumeFrom, 'validate');
  assert.match(unvalidated.headline, /第 3 步（校验）/);
  const failed = exportFlow(input({ job: job(), delivery: { status: 'failed', message: '压缩包缺少清单' } }));
  assert.deepEqual(states(failed), ['passed', 'passed', 'passed', 'failed']);
  assert.equal(failed.steps[3].message, '压缩包缺少清单');
  assert.equal(failed.resumeFrom, 'package');
  assert.match(failed.headline, /已通过的检查、渲染、校验不会重做/);
});
