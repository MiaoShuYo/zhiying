import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
export type ByteRange = { start: number; end: number };
/**
 * Parses a single `bytes=` range.
 * Returns `null` when the header is absent or unsupported (serve the whole file),
 * and `'unsatisfiable'` when the client asked for bytes beyond the file.
 */
export function parseByteRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable';
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (end < start) return 'unsatisfiable';
  return { start, end };
}
/** Streams a file, honouring the request's range so the player can seek before the download ends. */
export function videoStreamResponse(path: string, size: number, rangeHeader: string | null, headers: Record<string, string>): Response {
  const headersWithRanges = { ...headers, 'accept-ranges': 'bytes' };
  const range = parseByteRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headersWithRanges, 'content-range': `bytes */${size}` } });
  }
  if (!range) {
    const whole = Readable.toWeb(createReadStream(path)) as ReadableStream;
    return new Response(whole, { headers: { ...headersWithRanges, 'content-length': String(size) } });
  }
  const part = Readable.toWeb(createReadStream(path, { start: range.start, end: range.end })) as ReadableStream;
  return new Response(part, {
    status: 206,
    headers: {
      ...headersWithRanges,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': String(range.end - range.start + 1),
    },
  });
}
/** Size of the file the player would receive, so HEAD can answer without opening a stream. */
export function videoHeaders(size: number, disposition: string): Record<string, string> {
  return { 'content-type': 'video/mp4', 'content-disposition': disposition, 'content-length': String(size), 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
}
