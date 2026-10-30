// Minimal tar reader for generation layers (PLAN M6). Accepts regular files and folders only (ustar, pax `path`,
// GNU long names); refuses links, devices, absolute paths and `..`. Input may be gzip-compressed.
import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface TarEntry {
  path: string;
  type: 'file' | 'dir';
  data: Buffer;
}

function str(b: Buffer, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString('utf8');
}

function octal(b: Buffer, off: number, len: number): number {
  if (b[off] & 0x80) throw new Error('base-256 sizes are not supported');
  const s = str(b, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

export function safePath(raw: string): string {
  const p = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (p === '' || p === '.') return '';
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('\\')) throw new Error(`absolute path in archive: ${raw}`);
  if (p.split('/').some((s) => s === '..' || s === '')) throw new Error(`unsafe path in archive: ${raw}`);
  return p;
}

export function readTar(input: Buffer, maxBytes: number): TarEntry[] {
  const buf = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input, { maxOutputLength: maxBytes }) : input;
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const prefix = str(h, 257, 6).startsWith('ustar') ? str(h, 345, 155) : '';
    const name = longName ?? paxPath ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new Error('truncated archive');
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = str(data, 0, data.length);
      continue;
    }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue;
    longName = null;
    paxPath = null;
    const path = safePath(name);
    if (type === '0' || type === '\0' || type === '7') {
      if (!path) throw new Error('file entry without a name');
      out.push({ path, type: 'file', data });
    } else if (type === '5') {
      if (path) out.push({ path, type: 'dir', data: Buffer.alloc(0) });
    } else {
      throw new Error(`unsupported entry type '${type}' for ${name} (links and devices are refused)`);
    }
  }
  return out;
}

export function extractTo(entries: TarEntry[], dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    const p = join(dest, e.path);
    if (e.type === 'dir') mkdirSync(p, { recursive: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, e.data, { flag: 'wx' });
    }
  }
}
