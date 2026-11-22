import { StoryboardSchema, type Storyboard } from '@m2v/schema';

/**
 * Fixed, source-grounded V1.9.0 visual-quality fixture set.
 * Keep the facts and ordering stable: render snapshots, density tests, visual QA and
 * acceptance exports all use this same content instead of inventing per-test samples.
 */
export const visualQualitySourceSamples = {
  technicalProcess: {
    title: '从输入到输出：编译器的三个阶段',
    facts: ['词法分析把字符变成记号', '语法分析把记号组织成语法树', '代码生成把语法树转换为目标代码'],
    narration: '编译器通常经过三个阶段。词法分析把字符变成记号，语法分析把记号组织成语法树，代码生成再把语法树转换为目标代码。',
  },
  comparison: {
    title: '同步与异步 I/O',
    facts: ['同步调用等待结果返回', '异步调用允许调用方继续执行', '异步不代表任务一定更快'],
  },
  dataAnalysis: {
    title: '季度活跃用户',
    rows: [
      { label: '第一季度', value: 120 },
      { label: '第二季度', value: 150 },
      { label: '第三季度', value: 180 },
      { label: '第四季度', value: 210 },
    ],
    unit: '万人',
  },
  timeline: {
    title: '一次请求的处理顺序',
    facts: [
      { date: '步骤 1', label: '接收请求' },
      { date: '步骤 2', label: '校验参数' },
      { date: '步骤 3', label: '读取数据' },
      { date: '步骤 4', label: '返回结果' },
    ],
  },
  longText: {
    title: '缓存一致性的边界',
    facts: [
      '缓存能够减少重复读取，但缓存副本会在更新后短暂滞后。',
      '写入主存后删除缓存属于常见策略，但删除失败仍可能留下旧值。',
      '设置过期时间可以限制旧值最长保留时长，不能保证所有读取都实时一致。',
      '对账、重试和版本号可降低不一致风险，具体选择取决于业务允许的延迟。',
    ],
  },
  longTable: {
    title: '十二个月服务可用率记录',
    headers: ['月份', '可用率', '维护窗口'],
    rows: Array.from({ length: 12 }, (_, index) => [
      `${index + 1} 月`,
      `${99.90 + (index % 3) * 0.01}%`,
      index === 5 ? '计划维护 30 分钟' : '无',
    ]),
  },
  nestedBullets: {
    title: '缓存一致性的五层检查清单',
    items: Array.from({ length: 5 }, (_, parent) => ({
      text: `第 ${parent + 1} 项：检查缓存一致性过程中的主步骤与对应边界条件。`,
      children: Array.from({ length: 4 }, (_, child) => `第 ${parent + 1}.${child + 1} 项补充：验证更新顺序、失败重试与可观察结果。`),
    })),
  },
  flow: {
    title: '一次请求的十二步处理流程',
    nodes: Array.from({ length: 12 }, (_, index) => ({
      id: `flow-step-${index + 1}`,
      label: `第 ${index + 1} 步：${[
        '接收请求并记录追踪编号', '解析路径和查询参数', '检查调用方身份', '验证输入字段范围',
        '读取权限与限流配置', '查询缓存中的响应', '必要时请求主数据库', '校验记录版本与状态',
        '组装稳定的响应结构', '写回可复用缓存结果', '记录耗时和错误指标', '返回响应并结束追踪',
      ][index]}`,
    })),
  },
} as const;

const scenes = [
  {
    id: 'v190-hero', type: 'title', title: visualQualitySourceSamples.technicalProcess.title,
    narration: visualQualitySourceSamples.technicalProcess.narration,
    visual: { text: visualQualitySourceSamples.technicalProcess.facts[0] },
    wordTimings: [
      { text: '编译器', start: 0, end: 0.5 },
      { text: '通常经过', start: 0.5, end: 1 },
      { text: '三个阶段', start: 1, end: 1.6 },
    ],
  },
  {
    id: 'v190-comparison', type: 'comparison', title: visualQualitySourceSamples.comparison.title,
    narration: visualQualitySourceSamples.comparison.facts.join('；'),
    visual: { columns: [
      { title: '同步', items: [visualQualitySourceSamples.comparison.facts[0]] },
      { title: '异步', items: [visualQualitySourceSamples.comparison.facts[1], visualQualitySourceSamples.comparison.facts[2]] },
    ] },
  },
  {
    id: 'v190-diagram', type: 'diagram', title: visualQualitySourceSamples.technicalProcess.title,
    narration: visualQualitySourceSamples.technicalProcess.facts.join('，'),
    visual: { nodes: visualQualitySourceSamples.technicalProcess.facts.map((label, index) => ({ id: `stage-${index + 1}`, label })) },
  },
  {
    id: 'v190-timeline', type: 'timeline', title: visualQualitySourceSamples.timeline.title,
    narration: visualQualitySourceSamples.timeline.facts.map(item => item.label).join('，'),
    visual: { items: visualQualitySourceSamples.timeline.facts },
  },
  {
    id: 'v190-chart', type: 'chart', title: visualQualitySourceSamples.dataAnalysis.title,
    narration: '四个季度的活跃用户分别为 120、150、180、210 万人。',
    visual: { data: visualQualitySourceSamples.dataAnalysis.rows },
  },
  {
    id: 'v190-long-text', type: 'text', title: visualQualitySourceSamples.longText.title,
    narration: visualQualitySourceSamples.longText.facts.join(''),
    visual: { text: visualQualitySourceSamples.longText.facts.join('\n\n') },
    wordTimings: [
      { text: '缓存能够减少重复读取', start: 0, end: 2 },
      { text: '但缓存副本会在更新后短暂滞后', start: 2, end: 4 },
    ],
  },
  {
    id: 'v190-long-table', type: 'table', title: visualQualitySourceSamples.longTable.title,
    narration: '下表记录十二个月的服务可用率与维护窗口。',
    visual: { headers: visualQualitySourceSamples.longTable.headers, rows: visualQualitySourceSamples.longTable.rows },
  },
];

export const visualQualityStoryboard: Storyboard = StoryboardSchema.parse({
  title: 'V1.9.0 固定视觉质量样例',
  aspectRatio: '16:9',
  styleId: 'minimal-tech',
  transition: 'none',
  subtitles: { enabled: true, position: 'bottom' },
  scenes,
});

export function storyboardForVisualQuality(aspectRatio: '16:9' | '9:16'): Storyboard {
  return StoryboardSchema.parse({ ...visualQualityStoryboard, aspectRatio });
}
