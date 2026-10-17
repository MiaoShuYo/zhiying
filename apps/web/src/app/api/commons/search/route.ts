import { NextResponse } from 'next/server';
import { readCredit } from '@/lib/commons-license';

export const runtime = 'nodejs';
type SearchImage = { thumburl?: string; url?: string; extmetadata?: Record<string, { value?: string }> };
type SearchPage = { title: string; fullurl?: string; imageinfo?: SearchImage[] };

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q')?.trim();
  if (!query || query.length > 120) return NextResponse.json({ error: '请输入 1 到 120 个字符的搜索词' }, { status: 400 });
  const api = new URL('https://commons.wikimedia.org/w/api.php');
  for (const [key, value] of Object.entries({ action: 'query', format: 'json', generator: 'search', gsrsearch: query, gsrnamespace: '6', gsrlimit: '12', prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '480' })) api.searchParams.set(key, value);
  try {
    const response = await fetch(api, { headers: { 'user-agent': 'ZhiyingLocalStudio/1.0 (local visual asset picker)' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Wikimedia Commons 返回 ${response.status}`);
    const payload = await response.json() as { query?: { pages?: Record<string, SearchPage> } };
    const images = Object.values(payload.query?.pages ?? {}).flatMap(page => {
      const info = page.imageinfo?.[0];
      if (!info?.thumburl || !info.url || !info.url.startsWith('https://upload.wikimedia.org/')) return [];
      const sourceUrl = page.fullurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}`;
      return [{ title: page.title, thumbnail: info.thumburl, fileUrl: info.url, ...readCredit(info.extmetadata ?? {}, sourceUrl) }];
    });
    return NextResponse.json({ images });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '图片搜索失败' }, { status: 502 }); }
}
