import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

async function main() {
  const repo = process.cwd(), sandbox = resolve(repo, 'data', `test-v12-${randomUUID()}`);
  await mkdir(join(sandbox, 'apps/web/public/audio'), { recursive: true });
  process.env.DATABASE_URL = `file:${join(sandbox, 'test.db').replaceAll('\\', '/')}`;
  const sql = execFileSync(process.execPath, [join(repo, 'apps/web/node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(repo, 'apps/web/prisma/schema.prisma'), '--script'], { env: process.env, encoding: 'utf8' });
  const database = new DatabaseSync(join(sandbox, 'test.db')); database.exec(sql); database.close();
  process.chdir(join(sandbox, 'apps/web'));
  const { db } = await import('../src/lib/db');
  const { saveStoryboard, parseProject } = await import('../src/lib/pipeline');
  const { GET: readSubtitles } = await import('../src/app/api/projects/[id]/subtitles/route');
  try {
    const project = await db.project.create({ data: { name: '字幕时间轴', sourceText: '正文。'.repeat(10), status: 'awaiting_review' } });
    const subtitles = (id: string, format: string) => readSubtitles(new Request(`http://localhost/api/projects/${id}/subtitles?format=${format}`), { params: Promise.resolve({ id }) });
    const first = randomUUID(), second = randomUUID();
    const board = {
      title: '手动时间轴',
      styleId: 'minimal-tech',
      aspectRatio: '16:9',
      scenes: [
        {
          id: first, type: 'bullets', narration: '自动字幕不该出现。', duration: 4, audioDuration: 2, visual: { items: ['甲', '乙'] },
          subtitleCues: [{ text: '手动甲', start: 0.3, end: 1.2 }, { text: '手动乙', start: 1.4, end: 1.9 }],
        },
        { id: second, type: 'title', narration: '第二个场景自动切分。', duration: 5, audioDuration: 5 },
      ],
    };
    await saveStoryboard(project.id, board, 0);
    const reloaded = parseProject(await db.project.findUniqueOrThrow({ where: { id: project.id }, include: { scenes: true } })).storyboard!;
    assert.deepEqual(reloaded.scenes[0].subtitleCues, [{ text: '手动甲', start: 0.3, end: 1.2 }, { text: '手动乙', start: 1.4, end: 1.9 }], 'cue 时间必须原样落库');
    assert.equal(reloaded.scenes[1].subtitleCues, undefined, '未编辑的场景不得写入字幕时间轴');

    const srt = await (await subtitles(project.id, 'srt')).text();
    assert.match(srt, /00:00:00,300 --> 00:00:01,200\n手动甲/, '手动起点不能被自动切分覆盖');
    assert.match(srt, /00:00:01,400 --> 00:00:01,900\n手动乙/);
    assert.ok(!srt.includes('自动字幕不该出现'), '手动场景必须完全替换自动结果');
    assert.match(srt, /00:00:04,000 --> /, '第二个场景必须接在整段画面之后，而不是接在 2 秒音频之后');
    for (const format of ['vtt', 'ass'] as const) assert.ok((await (await subtitles(project.id, format)).text()).includes('手动甲'), `${format} 导出必须包含手动字幕`);

    // 语音时长缩短后，手动字幕按画面可用时长截断，而不是溢出到下一个场景。
    const shortened = { ...reloaded, scenes: [{ ...reloaded.scenes[0], audioDuration: 1 }, reloaded.scenes[1]] };
    await saveStoryboard(project.id, shortened, 1);
    const clipped = await (await subtitles(project.id, 'srt')).text();
    assert.match(clipped, /00:00:00,950 --> 00:00:01,000\n手动乙/, '超出手动时长要截断到场景结尾');

    // 恢复自动生成：清空 subtitleCues 后回到按词对齐/按比例切分。
    const auto = { ...reloaded, scenes: [{ ...reloaded.scenes[0], subtitleCues: undefined }, reloaded.scenes[1]] };
    await saveStoryboard(project.id, auto, 2);
    const restored = await (await subtitles(project.id, 'srt')).text();
    assert.ok(restored.includes('自动字幕不该出现'), '恢复自动生成后必须回到自动切分');
    assert.ok(!restored.includes('手动甲'));

    const queued = await db.project.findUniqueOrThrow({ where: { id: project.id } });
    assert.equal(JSON.parse(queued.storyboardJson!).scenes[0].subtitleCues, undefined, '清空后不得残留旧 cue');

    assert.equal((await subtitles(project.id, 'txt')).status, 400, '非法格式必须被拒绝');
    const empty = await db.project.create({ data: { name: '无分镜', sourceText: '正文。'.repeat(10) } });
    assert.equal((await subtitles(empty.id, 'srt')).status, 404);

    // ---- Phase 2: 文档抽取复核与逐页重跑 ----
    const { splitIntoChapters, limitChapters } = await import('../src/lib/pipeline');
    const { pageSections } = await import('../src/lib/extraction');
    const pagedSource = '## 第 1 页\n# 甲\n内容甲\n## 第 2 页\n# 乙\n内容乙\n## 第 3 页\n# 丙\n内容丙';
    const chapters = limitChapters(splitIntoChapters('资料', pagedSource), 100);
    assert.deepEqual(chapters.map(chapter => chapter.page), [1, 2, 3], '章节必须记住来源页，方便回查与单页重跑');
    const paragraphChapters = splitIntoChapters('无标题资料', '## 第 1 页\n甲段。\n\n## 第 2 页\n乙段。');
    assert.deepEqual(paragraphChapters.map(chapter => chapter.page), [1], '无标题资料同样按页标记分章');
    assert.ok(paragraphChapters.every(chapter => !chapter.text.includes('## 第')), '页标记不能污染正文');

    const stored = { ...reloaded, scenes: [{ ...reloaded.scenes[0], sourcePage: 2 }, reloaded.scenes[1]] };
    await saveStoryboard(project.id, stored, 3);
    const withPage = parseProject(await db.project.findUniqueOrThrow({ where: { id: project.id }, include: { scenes: true } })).storyboard!;
    assert.equal(withPage.scenes[0].sourcePage, 2, '场景的来源页必须落库');
    assert.equal(withPage.scenes[0].subtitleCues?.length, 2, '保存来源页不能影响字幕时间轴');

    const { POST: rerunPages } = await import('../src/app/api/projects/[id]/source/pages/route');
    const callPages = (pid: string, body: unknown) => rerunPages(new Request(`http://localhost/api/projects/${pid}/source/pages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: pid }) });
    const plainProject = await db.project.create({ data: { name: '纯网页', sourceText: '正文。'.repeat(10), status: 'awaiting_review' } });
    assert.equal((await callPages(plainProject.id, { pages: [1] })).status, 400, '只有 PDF 支持按页重跑');
    assert.equal((await callPages('missing-project', { pages: [1] })).status, 404);

    const pdfProject = await db.project.create({ data: { name: '分页资料', status: 'awaiting_review', sourceText: '没有分页标记的正文', sourcePath: 'fake.pdf', storyboardJson: JSON.stringify({ title: '分页', styleId: 'minimal-tech', scenes: [{ id: 's1', type: 'title', narration: '旧内容。', sourcePage: 2 }] }) } });
    await writeFile(join(sandbox, 'fake.pdf'), '%PDF-1.4 fake');
    await mkdir(join(sandbox, 'data/projects', pdfProject.id), { recursive: true });
    const realFetch = globalThis.fetch;
    const stub = (pages: unknown[]) => { globalThis.fetch = (async () => Response.json({ pages })) as typeof fetch; };
    try {
      stub([{ page: 2, method: 'text', chars: 8, quality: 'good', warnings: [], text: '第二页重新识别' }]);
      assert.equal((await callPages(pdfProject.id, { pages: [2] })).status, 409, '没有分页标记的正文不能按页替换');
      await db.project.update({ where: { id: pdfProject.id }, data: { sourceText: '## 第 1 页\n第一页内容。\n\n## 第 2 页\n旧内容。' } });
      const response = await callPages(pdfProject.id, { pages: [2] });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const result = JSON.parse(text);
      assert.equal(pageSections(result.sourceText).sections[1].body, '第二页重新识别');
      assert.equal(pageSections(result.sourceText).sections[0].body, '第一页内容。', '重跑一页不能改动其它页面');
      assert.deepEqual(result.staleScenes.map((scene: { id: string }) => scene.id), ['s1'], '必须提示受影响的场景');
      assert.deepEqual(result.failedPages, []);
      const meta = JSON.parse(await readFile(join(sandbox, 'data/projects', pdfProject.id, 'extraction.json'), 'utf8'));
      assert.deepEqual(meta.pageInfo.map((page: { page: number }) => page.page), [1, 2], 'extraction.json 的逐页状态必须覆盖全部页面');
      const rerunRow = meta.pageInfo.find((page: { page: number }) => page.page === 2);
      assert.equal(rerunRow.chars, 8, '重跑的页面要记录真实统计');
      assert.equal('text' in rerunRow, false, 'extraction.json 不能重复保存页面正文');
      assert.equal(meta.pages, 2);
      assert.equal((await db.project.findUniqueOrThrow({ where: { id: pdfProject.id } })).sourceText, result.sourceText);

      // 重跑仍失败时保留上一次成功的内容，避免整页丢失。
      stub([{ page: 2, method: 'none', chars: 0, quality: 'poor', warnings: ['此页没有识别出文字'], error: 'tesseract 超时', text: '' }]);
      const failed = await (await callPages(pdfProject.id, { pages: [2] })).json();
      assert.equal(pageSections(failed.sourceText).sections[1].body, '第二页重新识别');
      assert.deepEqual(failed.failedPages, [{ page: 2, error: 'tesseract 超时' }]);
      assert.equal((await callPages(pdfProject.id, { pages: [] })).status, 400);
      assert.equal((await callPages(pdfProject.id, { pages: Array.from({ length: 51 }, (_, index) => index + 1) })).status, 400);

      // 旧版 PDF 只有 ocrPages/failedPages，没有逐页状态；重跑一页后其余页面必须仍在列表里。
      const legacyProject = await db.project.create({ data: { name: '旧版 PDF', status: 'awaiting_review', sourceText: '## 第 1 页\n第一页内容。\n\n## 第 2 页\n第二页内容。', sourcePath: 'legacy.pdf' } });
      await writeFile(join(sandbox, 'legacy.pdf'), '%PDF-1.4 legacy');
      await mkdir(join(sandbox, 'data/projects', legacyProject.id), { recursive: true });
      await writeFile(join(sandbox, 'data/projects', legacyProject.id, 'extraction.json'), JSON.stringify({ kind: 'pdf', filename: 'legacy.pdf', pages: 2, extractedAt: new Date().toISOString() }));
      stub([{ page: 1, method: 'ocr', chars: 9, quality: 'good', warnings: [], text: '第一页重新识别' }]);
      const legacyResult = await (await callPages(legacyProject.id, { pages: [1] })).json();
      assert.deepEqual(legacyResult.pages.map((page: { page: number }) => page.page), [1], '只返回本次重跑的页面');
      const legacyMeta = JSON.parse(await readFile(join(sandbox, 'data/projects', legacyProject.id, 'extraction.json'), 'utf8'));
      assert.deepEqual(legacyMeta.pageInfo.map((page: { page: number }) => page.page), [1, 2], '旧数据的其它页面不能从逐页列表消失');
      assert.equal(legacyMeta.pageInfo[0].chars, 9);
      assert.equal(legacyMeta.pageInfo[1].quality, 'fair', '未重跑的旧页面标记为需复核，仍可单独重跑');
      assert.ok(legacyMeta.pageInfo[1].warnings.length > 0);
      assert.equal(pageSections(legacyResult.sourceText).sections[1].body, '第二页内容。', '未重跑的页面正文保持不变');
      stub([{ page: 2, method: 'text', chars: 11, quality: 'good', warnings: [], text: '第二页重新识别' }]);
      const legacyRerun = await (await callPages(legacyProject.id, { pages: [2] })).json();
      assert.equal(pageSections(legacyRerun.sourceText).sections[1].body, '第二页重新识别', '其余页面仍能单独重跑');
      assert.equal(pageSections(legacyRerun.sourceText).sections[0].body, '第一页重新识别', '再次重跑不能丢失上一页的重跑结果');
    } finally { globalThis.fetch = realFetch; }

    // ---- Phase 3: 任务中心与恢复入口 ----
    const { GET: readTasks } = await import('../src/app/api/tasks/route');
    const { POST: recoverTasks } = await import('../src/app/api/tasks/recover/route');
    const listTasks = async (query = '') => {
      const response = await readTasks(new Request(`http://localhost/api/tasks${query}`));
      assert.equal(response.status, 200);
      return await response.json() as { tasks: Record<string, any>[]; active: number };
    };
    const tasksProject = await db.project.create({ data: { name: '任务中心', sourceText: '正文。'.repeat(10), status: 'failed' } });
    await db.job.create({ data: { projectId: tasksProject.id, kind: 'storyboard', status: 'failed', stage: 'analyzing', attempt: 2, error: 'ollama 连接失败', progress: JSON.stringify({ phase: 'storyboarding', message: '已完成 1 / 3 章', completedChapters: 1, chapterCount: 3, percent: 48 }) } });

    const initial = await listTasks(`?projectId=${tasksProject.id}`);
    assert.equal(initial.tasks.length, 1, '聚合接口必须只返回本项目任务');
    const [storyboardTask] = initial.tasks;
    assert.equal(storyboardTask.projectName, '任务中心', '任务要带上项目名，列表才能脱离项目页使用');
    assert.equal(storyboardTask.percent, 48, '进度百分比来自 Job.progress');
    assert.equal(storyboardTask.message, '已完成 1 / 3 章');
    assert.equal(storyboardTask.error, 'ollama 连接失败');
    assert.equal(storyboardTask.retryMode, 'step', '失败的长文任务可以按步骤重试');
    assert.deepEqual(storyboardTask.chapters?.map((chapter: { done: boolean }) => chapter.done), [true, false, false], '缺少 chapters.json 时仍要能区分已完成与待处理章节');
    assert.equal(storyboardTask.chapters?.[2].title, '第 3 章');

    // chapters.json 存在时用真实章节标题和来源页。
    await mkdir(join(sandbox, 'data/projects', tasksProject.id), { recursive: true });
    await writeFile(join(sandbox, 'data/projects', tasksProject.id, 'chapters.json'), JSON.stringify([{ index: 1, title: '引言', page: 1 }, { index: 2, title: '方法' }, { index: 3, title: '结论' }]));
    const withChapters = await listTasks(`?projectId=${tasksProject.id}`);
    assert.deepEqual(withChapters.tasks[0].chapters, [{ index: 1, title: '引言', done: true, page: 1 }, { index: 2, title: '方法', done: false }, { index: 3, title: '结论', done: false }], 'chapters.json 的标题与页号必须进入任务清单');

    const renderJob = await db.job.create({ data: { projectId: tasksProject.id, kind: 'render', status: 'failed', stage: 'rendering', attempt: 1, error: '素材缺失' } });
    await db.job.create({ data: { projectId: tasksProject.id, kind: 'tts', status: 'completed', stage: 'generating_audio', attempt: 1 } });
    const runningAudio = await db.job.create({ data: { projectId: tasksProject.id, kind: 'tts', status: 'running', stage: 'generating_audio', attempt: 1 } });

    const failedOnly = await listTasks(`?projectId=${tasksProject.id}&status=failed`);
    assert.equal(failedOnly.tasks.length, 2, '状态筛选只保留失败任务');
    assert.equal(failedOnly.tasks.find(task => task.kind === 'render')?.retryMode, 'render', '失败的渲染走重新渲染入口');
    const renderOnly = await listTasks(`?projectId=${tasksProject.id}&kind=render`);
    assert.deepEqual(renderOnly.tasks.map(task => task.id), [renderJob.id], '类型筛选只返回渲染任务');
    const activeOnly = await listTasks('?status=active');
    assert.deepEqual(activeOnly.tasks.map(task => task.id), [runningAudio.id], '进行中筛选返回所有活跃任务');
    assert.ok(activeOnly.active >= 1, 'active 是全局进行中数量，用于轮询与导航角标');
    assert.equal(activeOnly.tasks[0].retryMode, null, '刚启动的任务不提供恢复入口');
    assert.equal((await listTasks('?limit=1')).tasks.length, 1, 'limit 必须生效');
    assert.equal((await listTasks('?limit=0')).tasks.length >= 3, true, '非法 limit 回落到默认条数');
    assert.equal((await listTasks('?limit=500&projectId=' + tasksProject.id)).tasks.length, 4, 'limit 上限被夹住且不报错');

    // 恢复入口是后端的集中出口，不依赖前端轮询。
    const recovered = await recoverTasks();
    assert.equal(recovered.status, 200);
    const recoverBody = await recovered.json() as { resumed: number; released: number; projects: number };
    assert.equal(typeof recoverBody.resumed, 'number');
    assert.equal(typeof recoverBody.released, 'number');
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: runningAudio.id } })).status, 'running', '新鲜任务不能被恢复流程打断');

    // 重试必须只创建一个新任务，重复点击不得叠加。
    await db.job.update({ where: { id: runningAudio.id }, data: { status: 'completed' } }); // 活跃任务会持有项目锁，先收尾
    const { POST: retryProject } = await import('../src/app/api/projects/[id]/retry/route');
    const callRetry = async (pid: string, mode: string) => {
      try {
        return await retryProject(new Request(`http://localhost/api/projects/${pid}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) }), { params: Promise.resolve({ id: pid }) });
      } catch (error) {
        // next/server 的 after() 只在请求作用域内可用；这里已经提交事务，只观察落库结果。
        if (String((error as Error).message).includes('after')) return null;
        throw error;
      }
    };
    const storyboardJobs = () => db.job.count({ where: { projectId: tasksProject.id, kind: 'storyboard' } });
    assert.equal(await storyboardJobs(), 1);
    await callRetry(tasksProject.id, 'step');
    assert.equal(await storyboardJobs(), 2, '重试只创建一个新任务');
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: tasksProject.id } })).status, 'analyzing', '重试把项目重新放回执行状态');
    const duplicate = await callRetry(tasksProject.id, 'step');
    assert.equal(duplicate?.status, 409, '执行中的项目不能被重复重试');
    assert.equal(await storyboardJobs(), 2, '重复点击不能叠加任务');

    // ---- Phase 4: 导出前检查与服务端拦截 ----
    const { GET: readPreflight } = await import('../src/app/api/projects/[id]/preflight/route');
    const { POST: renderProject } = await import('../src/app/api/projects/[id]/render/route');
    const preflightOf = async (pid: string, preset: 'full' | 'draft' = 'full') => {
      const response = await readPreflight(new Request(`http://localhost/api/projects/${pid}/preflight?preset=${preset}`), { params: Promise.resolve({ id: pid }) });
      return { status: response.status, body: await response.json() as { issues: { code: string; severity: string; sceneIndex?: number }[]; blocking: number; warnings: number; estimatedSeconds: number; width: number; height: number; preset: string; error?: string } };
    };
    const renderOf = async (pid: string, body: Record<string, unknown>) => {
      const response = await renderProject(new Request(`http://localhost/api/projects/${pid}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: pid }) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    assert.equal((await preflightOf('missing-project')).status, 404, '不存在的项目要单独报 404');
    const bareProject = await db.project.create({ data: { name: '没有分镜', sourceText: '正文。'.repeat(5), status: 'awaiting_review' } });
    assert.equal((await preflightOf(bareProject.id)).status, 400, '没有分镜时不能做导出前检查');

    const checkProject = await db.project.create({ data: { name: '导出检查', sourceText: '图片讲解。', status: 'awaiting_review', aspectRatio: '16:9' } });
    const imagePath = `projects/${checkProject.id}/assets/pic.png`;
    const audioPath = `audio/${checkProject.id}.wav`;
    const deliver = (patch: Record<string, unknown>) => ({ title: '交付检查', styleId: 'minimal-tech', aspectRatio: '16:9', scenes: [{ id: randomUUID(), type: 'media', narration: '图片讲解。', duration: 6, visual: { src: imagePath }, ...patch }] });
    await saveStoryboard(checkProject.id, deliver({}), 0);

    // 图片没上传、语音没生成：两个错误都要落到具体场景。
    const broken = await preflightOf(checkProject.id);
    assert.equal(broken.status, 200);
    assert.equal(broken.body.blocking, 2, JSON.stringify(broken.body.issues));
    const brokenCodes = broken.body.issues.map(issue => issue.code);
    assert.ok(brokenCodes.includes('missing_file'), '服务端必须发现素材文件不存在');
    assert.ok(brokenCodes.includes('missing_audio'), '没有语音的场景必须报错');
    assert.equal(broken.body.issues.find(issue => issue.code === 'missing_file')?.sceneIndex, 0, '问题必须能定位到场景');
    assert.equal(broken.body.estimatedSeconds, 6, '预计时长按场景时长累加');
    assert.equal(broken.body.width, 1920); assert.equal(broken.body.height, 1080);
    const draft = await preflightOf(checkProject.id, 'draft');
    assert.equal(draft.body.width, 960); assert.equal(draft.body.height, 540); assert.equal(draft.body.preset, 'draft');

    // 前端会先确认，但服务端必须自己再拦一次。
    const blocked = await renderOf(checkProject.id, { preset: 'full' });
    assert.equal(blocked.status, 422, '存在错误且未确认时必须拒绝导出');
    assert.equal(blocked.body.blocking, 2);
    assert.ok(Array.isArray(blocked.body.issues), '422 要带回问题清单供面板定位');
    assert.equal(await db.job.count({ where: { projectId: checkProject.id, kind: 'render' } }), 0, '被拦截时不能留下任务');

    // 任务中心的“重新渲染”同样是导出入口，必须走同一套导出前检查。
    const { POST: retryJob } = await import('../src/app/api/jobs/[id]/route');
    const retryRender = async (jid: string, body: Record<string, unknown> = {}) => {
      const response = await retryJob(new Request(`http://localhost/api/jobs/${jid}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: jid }) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const failedRender = await db.job.create({ data: { projectId: checkProject.id, kind: 'render', status: 'failed', stage: 'rendering', attempt: 1, error: '素材缺失', inputJson: JSON.stringify({ storyboard: { scenes: [] }, preset: 'draft' }) } });
    const refusedRetry = await retryRender(failedRender.id);
    assert.equal(refusedRetry.status, 422, '任务中心重新渲染不能绕过导出前检查');
    assert.equal(refusedRetry.body.blocking, 2);
    assert.ok(Array.isArray(refusedRetry.body.issues), '422 要把问题清单带回任务卡片');
    assert.equal(await db.job.count({ where: { projectId: checkProject.id, kind: 'render' } }), 1, '被拦截的重试不能留下新任务');

    const forcedRetry = await retryRender(failedRender.id, { allowIssues: true });
    assert.equal(forcedRetry.status, 202, '确认风险后才允许重新渲染');
    const forcedInput = JSON.parse((await db.job.findUniqueOrThrow({ where: { id: forcedRetry.body.id } })).inputJson!);
    assert.equal(forcedInput.allowIssues, true, '重试任务要记录风险确认');
    assert.equal(forcedInput.preset, 'draft', '重试沿用失败任务的档位');
    assert.equal(forcedInput.storyboard.title, '交付检查', '重试渲染当前分镜，而不是失败时的旧快照');
    assert.equal(forcedInput.storyboard.scenes.length, 1);
    assert.equal(await db.job.count({ where: { projectId: checkProject.id, kind: 'render' } }), 2);
    await db.job.update({ where: { id: forcedRetry.body.id }, data: { status: 'completed' } });

    const accepted = await renderOf(checkProject.id, { preset: 'full', allowIssues: true });
    assert.equal(accepted.status, 202, '确认风险后允许入队');
    const acceptedJob = await db.job.findUniqueOrThrow({ where: { id: accepted.body.jobId } });
    assert.equal(JSON.parse(acceptedJob.inputJson!).allowIssues, true, '任务要记录导出者已确认风险');
    assert.equal(JSON.parse(acceptedJob.inputJson!).preset, 'full');
    await db.job.update({ where: { id: acceptedJob.id }, data: { status: 'completed' } }); // 释放项目锁

    // 补齐素材与语音后检查归零；文件被删掉时即使登记过也要再报错。
    const publicDir = join(sandbox, 'apps/web/public');
    await mkdir(join(publicDir, 'projects', checkProject.id, 'assets'), { recursive: true });
    await writeFile(join(publicDir, ...imagePath.split('/')), 'png');
    await writeFile(join(publicDir, ...audioPath.split('/')), 'wav');
    await db.project.update({ where: { id: checkProject.id }, data: { assetsJson: JSON.stringify([{ path: imagePath, name: 'pic.png', kind: 'image' }]) } });
    await saveStoryboard(checkProject.id, deliver({ audioSrc: audioPath, audioDuration: 6 }), 1);
    assert.equal((await preflightOf(checkProject.id)).body.blocking, 0, '素材与语音齐全时不应再有错误');

    await rm(join(publicDir, ...imagePath.split('/')));
    assert.ok((await preflightOf(checkProject.id)).body.issues.some(issue => issue.code === 'missing_file'), '登记过的素材被删除同样要报错');
    await writeFile(join(publicDir, ...imagePath.split('/')), 'png');

    const cleanRender = await renderOf(checkProject.id, { preset: 'draft' });
    assert.equal(cleanRender.status, 202, '没有错误时直接入队');
    const cleanJob = await db.job.findUniqueOrThrow({ where: { id: cleanRender.body.jobId } });
    const cleanInput = JSON.parse(cleanJob.inputJson!);
    assert.equal(cleanInput.allowIssues, false, '没有错误时不写入风险确认');
    assert.equal(cleanInput.preset, 'draft', '草稿档位要原样传给渲染任务');
    await db.job.update({ where: { id: cleanJob.id }, data: { status: 'completed' } });

    // ---- Phase 5: 素材与项目维护 ----
    const { GET: storageGet, DELETE: storageDelete } = await import('../src/app/api/projects/[id]/storage/route');
    const { GET: backupsGet } = await import('../src/app/api/projects/[id]/backups/route');
    const { createSnapshot } = await import('../src/lib/backups');
    const storageOf = (pid: string) => storageGet(new Request(`http://localhost/api/projects/${pid}/storage`), { params: Promise.resolve({ id: pid }) });
    const cleanOf = (pid: string, paths: string[]) => storageDelete(new Request(`http://localhost/api/projects/${pid}/storage`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }) }), { params: Promise.resolve({ id: pid }) });

    const storeProject = await db.project.create({ data: { name: '素材维护', sourceText: '正文。'.repeat(10), status: 'awaiting_review' } });
    const repoRoot = join(sandbox, 'data/projects', storeProject.id, 'assets');
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, 'used.png'), 'used-bytes');
    await writeFile(join(repoRoot, 'spare.png'), 'spare-bytes-here');
    const usedPath = `projects/${storeProject.id}/assets/used.png`;
    const sparePath = `projects/${storeProject.id}/assets/spare.png`;
    await saveStoryboard(storeProject.id, { title: '素材', styleId: 'minimal-tech', aspectRatio: '16:9', scenes: [{ id: randomUUID(), type: 'media', narration: '看图。', duration: 6, visual: { src: usedPath } }] }, 0);
    await db.project.update({ where: { id: storeProject.id }, data: { assetsJson: JSON.stringify([{ path: usedPath, name: 'used.png', kind: 'image' }, { path: sparePath, name: 'spare.png', kind: 'image' }]) } });

    const storage = await (await storageOf(storeProject.id)).json() as { assets: { path: string; referenced: boolean; bytes: number }[]; unreferenced: string[]; totals: Record<string, number> };
    assert.equal(storage.assets.find(asset => asset.path === usedPath)?.referenced, true, '被场景引用的素材必须标记为已引用');
    assert.equal(storage.assets.find(asset => asset.path === sparePath)?.referenced, false, '没有被引用的素材要单独列出');
    assert.deepEqual(storage.unreferenced, [sparePath], '未引用清单只包含没人引用的素材');
    assert.equal(storage.totals.assets, 'used-bytes'.length + 'spare-bytes-here'.length, '素材占用按实际字节统计');
    assert.ok(storage.totals.total >= storage.totals.assets, '合计占用至少包含素材');

    const refused = await cleanOf(storeProject.id, [usedPath]);
    assert.equal(refused.status, 409, '已引用素材必须拒绝删除');
    assert.equal(await readFile(join(repoRoot, 'used.png'), 'utf8'), 'used-bytes', '被拒绝时不能动文件');
    const mixed = await cleanOf(storeProject.id, [usedPath, sparePath]);
    assert.equal(mixed.status, 200, '未引用素材可以被清理');
    assert.deepEqual((await mixed.json() as { deleted: string[] }).deleted, [sparePath], '引用中的素材要跳过');
    assert.equal(await readFile(join(repoRoot, 'used.png'), 'utf8'), 'used-bytes');
    await assert.rejects(() => readFile(join(repoRoot, 'spare.png')), '清理后文件必须真的删除');
    const afterClean = await db.project.findUniqueOrThrow({ where: { id: storeProject.id } });
    assert.deepEqual(JSON.parse(afterClean.assetsJson).map((asset: { path: string }) => asset.path), [usedPath], '清理后素材登记也要同步');
    assert.equal((await cleanOf(storeProject.id, [`projects/${storeProject.id}/source.pdf`])).status, 409, '源文件不在可清理范围');

    // 备份校验：完整快照报告 ok，被改动过的快照必须指出文件。
    const verifyProject = await db.project.create({ data: { name: '备份校验', sourceText: '正文。'.repeat(10), status: 'awaiting_review' } });
    await saveStoryboard(verifyProject.id, { title: '备份', styleId: 'minimal-tech', aspectRatio: '16:9', scenes: [{ id: randomUUID(), type: 'title', narration: '标题。', duration: 4 }] }, 0);
    await mkdir(join(sandbox, 'data/projects', verifyProject.id), { recursive: true });
    await writeFile(join(sandbox, 'data/projects', verifyProject.id, 'notes.txt'), 'snapshot-content');
    const snapshotId = await createSnapshot(verifyProject.id);
    assert.ok(snapshotId, '快照必须创建成功');
    const verify = async () => (await (await backupsGet(new Request(`http://localhost/api/projects/${verifyProject.id}/backups?verify=${snapshotId}`), { params: Promise.resolve({ id: verifyProject.id }) })).json()) as { ok: boolean; checked: number; missing: string[]; mismatched: string[] };
    const healthy = await verify();
    assert.equal(healthy.ok, true, '完好的快照要通过校验');
    assert.ok(healthy.checked > 0, '校验要覆盖快照里的文件');
    const manifestPath = join(sandbox, 'data/backups', verifyProject.id, snapshotId!, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: { path: string; size: number }[] };
    assert.ok(manifest.files.some(file => file.path === 'project/notes.txt'), '快照要包含项目文件');
    await writeFile(join(sandbox, 'data/backups', verifyProject.id, snapshotId!, 'files', 'project', 'notes.txt'), 'tampered-content-that-is-longer');
    const tampered = await verify();
    assert.equal(tampered.ok, false, '内容被改动后校验必须失败');
    assert.equal(tampered.mismatched.length, 1, '要指出损坏了哪个文件');

    // 项目列表搜索、状态筛选与排序。
    const { GET: listProjects } = await import('../src/app/api/projects/route');
    await db.project.update({ where: { id: storeProject.id }, data: { status: 'failed' } });
    const list = async (search: string) => (await (await listProjects(new Request(`http://localhost/api/projects${search}`))).json()) as { id: string; name: string; status: string; createdAt: string }[];
    const found = await list(`?q=${encodeURIComponent('素材维护')}`);
    assert.deepEqual(found.map(project => project.id), [storeProject.id], '搜索要能按名称命中');
    assert.ok(!(await list('?q=绝对不存在的关键字')).length, '没有命中时返回空列表');
    assert.ok((await list('?status=failed')).every(project => project.status === 'failed'), '状态筛选只返回匹配项目');
    assert.ok((await list('?status=failed')).some(project => project.id === storeProject.id));
    const namesAsc = (await list('?sort=name&order=asc')).map(project => project.name);
    const namesDesc = (await list('?sort=name&order=desc')).map(project => project.name);
    assert.equal(namesAsc.length, await db.project.count(), '排序不能丢项目');
    assert.ok(namesAsc.every((name, index) => index === 0 || namesAsc[index - 1] <= name), '升序结果必须逐项递增');
    assert.deepEqual(namesDesc, [...namesAsc].reverse(), 'order=desc 必须是 order=asc 的严格倒序');
    const created = (await list('?sort=created&order=desc')).map(project => project.createdAt);
    assert.equal(created.length, await db.project.count(), '按创建时间排序不能丢项目');
    assert.ok(created.every((value, index) => index === 0 || created[index - 1] >= value), 'sort=created&order=desc 必须按创建时间倒序');
    const shape = (await list(''))[0];
    assert.deepEqual(Object.keys(shape).sort(), ['busy', 'busyStage', 'createdAt', 'id', 'name', 'sceneCount', 'status', 'styleId'], '列表响应字段保持不变');

    console.log('PASS: cue-level subtitles persist through PUT /storyboard, drive SRT/VTT/ASS export, clamp to the real audio window, and fall back to auto timing when cleared. Page provenance reaches the storyboard and POST /source/pages re-extracts single pages without touching the rest of the source while keeping legacy per-page rows intact. GET /api/tasks aggregates kind/status/project with progress, chapter checklists and retry modes, POST /api/tasks/recover releases stale work, and retries never stack duplicate jobs. GET /preflight reports scene-level blocking issues with estimated duration and preset resolution, and both POST /render and the task-centre render retry (POST /api/jobs/:id) return 422 unless the caller confirms the risks with allowIssues, retrying the current storyboard instead of the stale snapshot stored on the failed job. GET /api/projects/:id/storage reports per-asset reference status plus disk totals and refuses to delete referenced files, GET /backups?verify= re-hashes snapshots, and GET /api/projects filters, sorts and searches without changing its response shape.');
  } finally { await db.$disconnect(); process.chdir(repo); for (let attempt = 0; attempt < 10; attempt++) { try { await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; } catch { await new Promise(done => setTimeout(done, 300)); } } }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
