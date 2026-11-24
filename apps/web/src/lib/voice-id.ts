/**
 * Directory name the Python voice service uses for a voice ID (#306).
 *
 * services/python/app/main.py keeps letters, digits (Unicode, like str.isalnum), "-", "_" and
 * spaces, trims, and replaces spaces with "-"; an empty result becomes "my-voice". "My Voice" is
 * therefore stored under "My-Voice" and Chinese IDs are valid. Every Web-side lookup of a voice
 * folder must use this mapping instead of the raw ID or the ASCII-only project-ID check.
 */
export function voiceDirectoryName(voiceId: string): string {
  const kept = [...voiceId].filter(char => /[\p{L}\p{N}]/u.test(char) || char === '-' || char === '_' || char === ' ').join('');
  return kept.trim().replace(/ /g, '-') || 'my-voice';
}
