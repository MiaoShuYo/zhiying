export type ExportStepKey = 'preflight' | 'render' | 'validate' | 'package';
export type ExportStepState = 'pending' | 'running' | 'passed' | 'failed' | 'blocked';
/** The single action that moves the flow forward from a step; the UI wires each one to an existing route. */
export type ExportStepAction = 'check' | 'render' | 'validate' | 'package';

export type ExportStep = {
  key: ExportStepKey;
  label: string;
  state: ExportStepState;
  message: string;
  action: ExportStepAction;
  at?: string;
};

export const exportStepOrder: ExportStepKey[] = ['preflight', 'render', 'validate', 'package'];

export const exportStepLabels: Record<ExportStepKey, string> = {
  preflight: '检查',
  render: '渲染',
  validate: '校验',
  package: '打包',
};

export const exportStepActions: Record<ExportStepKey, ExportStepAction> = {
  preflight: 'check',
  render: 'render',
  validate: 'validate',
  package: 'package',
};

/** Worker stages are the only progress signal a render has, so they get human names. */
export const renderStageLabels: Record<string, string> = {
  queued: '排队中',
  created: '已创建',
  bundling: '准备渲染资源',
  rendering: '渲染画面',
  encoding: '编码视频',
  validating: '校验成片',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  cancelling: '取消中',
};

export type ExportVideoState = 'current' | 'missing' | 'superseded';

export type ExportFlowJob = {
  id: string;
  status: string;
  stage?: string | null;
  error?: string | null;
  updatedAt: string;
  hasValidation: boolean;
  videoState: ExportVideoState;
};

export type ExportFlowDelivery = {
  status: 'missing' | 'failed' | 'ready';
  message?: string;
  at?: string;
};

export type ExportFlowInput = {
  /** Blocking issue count from the latest export check. */
  blocking: number;
  /** Project revision the last passing check saw; `null` when it never passed. */
  checkedRevision: number | null;
  revision: number;
  job: ExportFlowJob | null;
  delivery: ExportFlowDelivery | null;
};

export type ExportFlow = {
  steps: ExportStep[];
  /** First step that has not passed; `null` when every step passed. */
  resumeFrom: ExportStepKey | null;
  /** Steps already passed, so a retry can promise "不会重做". */
  passed: ExportStepKey[];
  canExport: boolean;
  headline: string;
};

const RUNNING = new Set(['queued', 'running', 'cancelling']);

const step = (key: ExportStepKey, state: ExportStepState, message: string, at?: string): ExportStep => ({
  key,
  label: exportStepLabels[key],
  state,
  message,
  action: exportStepActions[key],
  at,
});

function preflightStep(input: ExportFlowInput): ExportStep {
  if (input.blocking > 0) return step('preflight', 'blocked', `还有 ${input.blocking} 项阻断问题需要处理。`);
  if (input.checkedRevision === null) return step('preflight', 'pending', '还没有通过导出前检查。');
  if (input.checkedRevision !== input.revision) return step('preflight', 'pending', '分镜已修改，需要重新检查。');
  return step('preflight', 'passed', '检查通过，可以导出。');
}

function renderStep(job: ExportFlowJob | null): ExportStep {
  if (!job) return step('render', 'pending', '还没有导出过成片。');
  if (job.status === 'cancelled') return step('render', 'failed', '上次导出已取消，重新导出即可。', job.updatedAt);
  if (RUNNING.has(job.status)) {
    const phase = renderStageLabels[job.stage ?? ''] ?? '导出中';
    return step('render', 'running', `正在${phase}…`, job.updatedAt);
  }
  if (job.status === 'failed') {
    return step('render', 'failed', job.error?.trim() || '导出失败，原因未记录。', job.updatedAt);
  }
  if (job.status !== 'completed') return step('render', 'pending', `导出任务状态为 ${job.status}。`, job.updatedAt);
  if (job.videoState === 'superseded') return step('render', 'failed', '这次导出的视频已被后续导出覆盖，需要重新导出。', job.updatedAt);
  if (job.videoState === 'missing') return step('render', 'failed', '成片文件已不存在，需要重新导出。', job.updatedAt);
  return step('render', 'passed', '成片已渲染完成。', job.updatedAt);
}

function validateStep(job: ExportFlowJob | null): ExportStep {
  if (!job || job.status !== 'completed') return step('validate', 'pending', '导出成片后即可校验。');
  if (job.videoState !== 'current') return step('validate', 'failed', '成片文件不可用，校验无从进行。');
  if (!job.hasValidation) return step('validate', 'pending', '成片还没有校验。');
  return step('validate', 'passed', '成片文件校验通过。');
}

function packageStep(delivery: ExportFlowDelivery | null): ExportStep {
  if (!delivery || delivery.status === 'missing') return step('package', 'pending', '还没有生成交付包。');
  if (delivery.status === 'failed') return step('package', 'failed', delivery.message?.trim() || '上次打包失败，原因未记录。', delivery.at);
  return step('package', 'passed', '交付包已生成。', delivery.at);
}

function headlineFor(steps: ExportStep[], resumeFrom: ExportStepKey | null, blocking: number): string {
  if (!resumeFrom) return '四个步骤都已通过，可以交付。';
  const target = steps.find(item => item.key === resumeFrom)!;
  const index = exportStepOrder.indexOf(resumeFrom) + 1;
  if (resumeFrom === 'preflight') {
    return blocking > 0
      ? `先处理 ${blocking} 项阻断问题，再重新检查。`
      : '重新检查通过后即可从第 2 步（渲染）继续。';
  }
  if (target.state === 'running') return '正在导出成片，完成后会自动校验。';
  const done = steps.filter(item => item.state === 'passed').map(item => exportStepLabels[item.key]);
  const kept = done.length ? `已通过的${done.join('、')}不会重做。` : '';
  return `第 ${index} 步（${target.label}）${target.state === 'failed' ? '失败' : '未完成'}，从这一步继续即可。${kept}`;
}

/** Derives the four-step export flow from the records the app already keeps. */
export function exportFlow(input: ExportFlowInput): ExportFlow {
  const steps = [preflightStep(input), renderStep(input.job), validateStep(input.job), packageStep(input.delivery)];
  // An unfinished step invalidates the ones after it: their old records no longer describe
  // the export that is about to run, so they read as pending instead of "passed".
  const resumeIndex = steps.findIndex(item => item.state !== 'passed');
  if (resumeIndex !== -1) {
    const blocker = steps[resumeIndex];
    for (let index = resumeIndex + 1; index < steps.length; index += 1) {
      if (steps[index].state === 'passed') {
        steps[index] = { ...steps[index], state: 'pending', message: `需要先完成第 ${resumeIndex + 1} 步（${blocker.label}）。` };
      }
    }
  }
  const resumeFrom = resumeIndex === -1 ? null : exportStepOrder[resumeIndex];
  const passed = steps.filter(item => item.state === 'passed').map(item => item.key);
  return {
    steps,
    resumeFrom,
    passed,
    canExport: steps[0].state === 'passed',
    headline: headlineFor(steps, resumeFrom, input.blocking),
  };
}
