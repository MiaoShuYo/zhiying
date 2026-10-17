import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SceneSchema } from '@m2v/schema';
const directory = resolve(process.cwd(), '../../data/settings');
const path = resolve(directory, 'scene-templates.json');
async function list() { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return []; } }
export async function GET() { return Response.json(await list()); }
export async function POST(request: Request) {
  try {
    const body = await request.json(), scene = SceneSchema.parse(body.scene);
    if (scene.type === 'media') throw new Error('图片场景包含项目素材，请使用复制场景；可复用模板支持文字和图形版式');
    const items = await list();
    items.push({ name: String(body.name || '我的模板').slice(0, 50), scene: { ...scene, audioSrc: undefined, wordTimings: undefined, audioDuration: undefined, audioKey: undefined } });
    await mkdir(directory, { recursive: true }); await writeFile(path + '.tmp', JSON.stringify(items)); await rename(path + '.tmp', path);
    return Response.json(items);
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '模板保存失败' }, { status: 400 }); }
}
