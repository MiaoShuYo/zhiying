export type WordTiming = { text: string; start: number; end: number };
export type CaptionCue = { text: string; start: number; end: number };

/** Use original words and punctuation, even when the aligner returns letters. */
export function buildCaptionCues(narration: string, timings: WordTiming[] = [], duration = 6, portrait = false): CaptionCue[] {
  const units = [...narration.matchAll(/[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*|[^\s]/gu)];
  if (!units.length) return [];
  const source = [...narration.matchAll(/[\p{L}\p{N}]/gu)];
  const searchable = source.map(item => item[0].toLowerCase()).join('');
  const mapped: { offset: number; start: number; end: number }[] = [];
  let cursor = 0;
  for (const item of timings) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.end <= item.start || item.start < 0) continue;
    const key = [...item.text.matchAll(/[\p{L}\p{N}]/gu)].map(match => match[0].toLowerCase()).join('');
    if (!key) continue;
    const index = searchable.indexOf(key, cursor);
    if (index < 0) continue;
    for (let i = 0; i < key.length; i++) mapped.push({ offset: source[index + i]?.index ?? narration.length, start: item.start, end: item.end });
    cursor = index + key.length;
  }
  const groups: { text: string; from: number; to: number }[] = [];
  let from = units[0].index!;
  let length = 0;
  // Two short lines at most. Never split an English word into letters.
  const limit = portrait ? 24 : 38;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const weight = /^[A-Za-z0-9]/.test(unit[0]) ? unit[0].length * 0.55 : 1;
    if (length && length + weight > limit && !/^[，。！？、；：,.!?;:]$/.test(unit[0])) {
      groups.push({ text: narration.slice(from, unit.index).trim(), from, to: unit.index! });
      from = unit.index!;
      length = 0;
    }
    length += weight;
    if (/[。！？.!?；;]$/.test(unit[0]) || (/[，,：:]$/.test(unit[0]) && length >= limit / 2) || i === units.length - 1) {
      const to = unit.index! + unit[0].length;
      groups.push({ text: narration.slice(from, to).trim(), from, to });
      from = units[i + 1]?.index ?? to;
      length = 0;
    }
  }
  const totalWeight = groups.reduce((sum, group) => sum + group.text.length, 0);
  let elapsed = 0;
  let previousStart = 0;
  const cues = groups.map(group => {
    const matches = mapped.filter(item => item.offset >= group.from && item.offset < group.to);
    const estimate = duration * elapsed / totalWeight;
    elapsed += group.text.length;
    const start = Math.min(duration, Math.max(previousStart, matches[0]?.start ?? estimate));
    previousStart = start;
    return { text: group.text, start, end: Math.min(duration, Math.max(start, ...matches.map(item => item.end))) };
  });
  for (let i = 0; i < cues.length; i++) {
    // Keep each phrase until the next phrase starts, including tiny CTC gaps.
    cues[i].end = cues[i + 1]?.start ?? Math.max(duration, cues[i].end);
  }
  const timedCoverage = mapped.length / Math.max(1, source.length);
  if (timedCoverage < 0.65 || cues.some(cue => cue.end - cue.start < 0.12)) {
    let offset = 0;
    return groups.map((group, index) => {
      const start = duration * offset / totalWeight;
      offset += group.text.length;
      return { text: group.text, start, end: index === groups.length - 1 ? duration : duration * offset / totalWeight };
    });
  }
  return cues;
}

export function captionAt(cues: CaptionCue[], seconds: number): string {
  return cues.find(cue => seconds >= cue.start && seconds < cue.end)?.text ?? '';
}

export function captionNarration(scene: { type: string; narration: string; visual: Record<string, unknown> }): string {
  const attribution = String(scene.visual.attribution ?? '') + '，' + String(scene.visual.license ?? '');
  const narration = scene.type === 'media' && attribution !== '，' && scene.narration.startsWith(attribution) ? scene.narration.slice(attribution.length).replace(/^[，,。\s]+/, '') : scene.narration;
  return narration.trim() === '请添加图片讲解。' ? '' : narration;
}
