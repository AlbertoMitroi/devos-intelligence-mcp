// Context packs (`context/*.md`): deterministic Markdown cards written by the engines. Listed from the manifest, so
// only verified files are served, and matched to a project by path, name or file name.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Manifest } from './verify.ts';

export interface Pack {
  path: string;
  title: string;
  /** Project path or name the card is about, when the card says so. */
  project: string | null;
  kind: 'overview' | 'project' | 'service' | 'other';
  size: number;
}

export function listPacks(dir: string, manifest: Manifest): Pack[] {
  const files = (manifest.files ?? []).filter((f) => f.path.startsWith('context/') && f.path.endsWith('.md'));
  return files.map((f) => {
    const text = readFileSync(join(dir, f.path), 'utf8');
    const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? basename(f.path, '.md')).trim();
    const project = /^#\s+Project\s+.*\(`([^`]+)`\)/m.exec(text)?.[1] ?? /^-\s+Project:\s+`([^`]+)`/m.exec(text)?.[1] ?? null;
    const kind: Pack['kind'] = f.path === 'context/overview.md' ? 'overview' : f.path.startsWith('context/projects/') ? 'project' : f.path.startsWith('context/services/') ? 'service' : 'other';
    return { path: f.path, title, project, kind, size: f.size };
  });
}

/** Exact path, project path or name, then a case-insensitive substring of path or title. */
export function findPack(packs: Pack[], term: string): Pack[] {
  const t = term.trim().toLowerCase();
  const exact = packs.filter((p) => p.path.toLowerCase() === t || p.project?.toLowerCase() === t || basename(p.path, '.md').toLowerCase() === t || p.title.toLowerCase() === t);
  if (exact.length) return exact;
  return packs.filter((p) => p.path.toLowerCase().includes(t) || p.title.toLowerCase().includes(t) || (p.project ?? '').toLowerCase().includes(t));
}

export function readPack(dir: string, pack: Pack): string {
  return readFileSync(join(dir, pack.path), 'utf8');
}
