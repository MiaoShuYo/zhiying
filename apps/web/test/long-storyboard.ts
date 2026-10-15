import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { processProject, parseProject } from '../src/lib/pipeline';

// Run only against an explicitly created isolated regression database.
if (!process.env.DATABASE_URL?.includes('test-long-storyboard.db')) throw new Error('An isolated test database is required');

async function main() {
  const id = `regression-long-${randomUUID()}`;
  const sourceText = Array.from({ length: 332 }, (_, i) => `# Chapter ${i + 1}\nThis is the source material for chapter ${i + 1}.`).join('\n\n');
  await db.project.create({ data: { id, name: 'Long document regression', sourceText } });
  await db.job.create({ data: { projectId: id, kind: 'storyboard', status: 'running', stage: 'storyboarding' } });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let interrupt = true;
  globalThis.fetch = async (_input, init) => {
    calls++;
    if (interrupt && calls === 3) throw new Error('Simulated interruption');
    const payload = JSON.parse(String(init?.body));
    const chapters = JSON.parse(payload.messages[0].content.split('章节资料：')[1].split('\n/no_think')[0]);
    const scenes = chapters.map((chapter: { title: string; content: string }) => ({ id: 'model-repeats-id', type: 'title', title: chapter.title, narration: chapter.content }));
    return Response.json({ message: { content: JSON.stringify({ scenes }) } });
  };
  try {
    await processProject(id, 'storyboarding', true);
    assert.equal((await db.project.findUniqueOrThrow({ where: { id } })).status, 'failed');
    calls = 0;
    interrupt = false;
    await processProject(id, 'storyboarding', true);
    const project = await db.project.findUniqueOrThrow({ where: { id }, include: { scenes: { orderBy: { orderIndex: 'asc' } } } });
    assert.equal(project.status, 'awaiting_review');
    assert.equal(project.scenes.length, 332);
    assert.equal(new Set(project.scenes.map(scene => scene.id)).size, 332);
    assert.equal(project.scenes[331].title, 'Chapter 332');
    assert.equal(calls, Math.ceil(332 / 3) - 2, 'resume must skip the first two completed batches');
    assert.equal(parseProject(project).storyboard?.scenes.length, 332);
    console.log('PASS: 332 scenes persisted, unique IDs, original order, interruption resumed from checkpoint, editor hydration accepted.');
  } finally {
    globalThis.fetch = originalFetch;
    await db.$disconnect();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
