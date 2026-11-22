import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/audio/sfx');
const sampleRate = 22050;
const sounds = [
  { id: 'soft-transition', duration: 1.1, kind: 'sweep', start: 180, end: 520 },
  { id: 'emphasis-tick', duration: 0.18, kind: 'tick', start: 1450, end: 680 },
  { id: 'data-pop', duration: 0.42, kind: 'pop', start: 430, end: 760 },
  { id: 'flow-pulse', duration: 0.72, kind: 'sweep', start: 150, end: 360 },
  { id: 'success-chime', duration: 1.05, kind: 'chime', start: 523, end: 880 },
  { id: 'paper-tap', duration: 0.22, kind: 'tap', start: 190, end: 90 },
];

function envelope(t, duration, attack = 0.015, release = 0.18) {
  return Math.max(0, Math.min(1, t / attack, (duration - t) / release));
}

function sample(sound, t) {
  const env = envelope(t, sound.duration, sound.kind === 'tick' || sound.kind === 'tap' ? 0.002 : 0.035, sound.kind === 'chime' ? 0.44 : Math.min(0.2, sound.duration * 0.7));
  const progress = Math.max(0, Math.min(1, t / sound.duration));
  if (sound.kind === 'chime') {
    const notes = [[0, 523.25], [0.29, 659.25], [0.61, 783.99]];
    return notes.reduce((sum, [start, frequency]) => {
      const local = t - start;
      if (local < 0 || local > 0.52) return sum;
      const noteEnv = envelope(local, 0.52, 0.012, 0.32);
      return sum + Math.sin(2 * Math.PI * frequency * local) * noteEnv * 0.22;
    }, 0);
  }
  const frequency = sound.start + (sound.end - sound.start) * progress;
  if (sound.kind === 'tap') {
    const deterministicNoise = Math.sin(t * 14237.3) * Math.sin(t * 6151.9);
    return (deterministicNoise * 0.19 + Math.sin(2 * Math.PI * frequency * t) * 0.12) * env;
  }
  const fundamental = Math.sin(2 * Math.PI * frequency * t);
  const harmonic = Math.sin(2 * Math.PI * frequency * 2.01 * t) * (sound.kind === 'tick' ? 0.12 : 0.2);
  const pop = sound.kind === 'pop' ? Math.sin(2 * Math.PI * 42 * t) * Math.exp(-t * 15) * 0.25 : 0;
  return (fundamental * 0.24 + harmonic + pop) * env;
}

function makeWave(sound) {
  const count = Math.ceil(sampleRate * sound.duration);
  const dataLength = count * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  for (let index = 0; index < count; index += 1) {
    const value = Math.max(-1, Math.min(1, sample(sound, index / sampleRate)));
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return buffer;
}

await mkdir(outputDir, { recursive: true });
for (const sound of sounds) {
  await writeFile(resolve(outputDir, `${sound.id}.wav`), makeWave(sound));
}
console.log(`Generated ${sounds.length} offline SFX cues in ${outputDir}`);
