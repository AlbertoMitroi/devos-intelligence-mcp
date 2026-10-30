// Manifest verification before use (PLAN, resolution rule 8). Contract v1 compatibility rules: major 1, any minor;
// an unknown required capability refuses the generation; every listed file must match its size and SHA-256.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Manifest {
  schemaVersion: string;
  commit: string;
  status?: string;
  dirty?: boolean;
  engine?: { name: string; version: string };
  repository?: { remoteUrl?: string | null };
  requiredCapabilities?: string[];
  files?: { path: string; sha256: string; size: number }[];
  coverage?: { summary?: Record<string, number> };
  generationType?: string;
  system?: string;
  [k: string]: unknown;
}

/** Capabilities this consumer understands. None are defined by contract v1.1. */
export const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set();

export interface Verification {
  ok: boolean;
  errors: string[];
  notes: string[];
  manifest: Manifest | null;
  manifestSha256: string | null;
}

export function readManifest(dir: string): { manifest: Manifest | null; sha256: string | null; error?: string } {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return { manifest: null, sha256: null, error: 'no manifest.json' };
  const bytes = readFileSync(path);
  try {
    return { manifest: JSON.parse(bytes.toString('utf8')) as Manifest, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (e) {
    return { manifest: null, sha256: null, error: `manifest.json is not JSON: ${(e as Error).message}` };
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split('\\').join('/'));
  }
  return out;
}

/** Checks the header first (cheap), then every listed file. Files not listed are notes, except `manifest.json` and `run.json`. */
export async function verifyGeneration(dir: string): Promise<Verification> {
  const errors: string[] = [];
  const notes: string[] = [];
  const { manifest, sha256, error } = readManifest(dir);
  if (!manifest) return { ok: false, errors: [error ?? 'no manifest'], notes, manifest: null, manifestSha256: null };
  const major = /^(\d+)\./.exec(String(manifest.schemaVersion ?? ''))?.[1];
  if (major !== '1') errors.push(`schemaVersion '${manifest.schemaVersion}' is not major 1`);
  // A system generation's commit is `system:{sha256}` over its inputs (contract v1.2, system generation).
  const commitPattern = manifest.generationType === 'system' ? /^system:[0-9a-f]{64}$/ : /^[0-9a-f]{40}([0-9a-f]{24})?$/;
  if (typeof manifest.commit !== 'string' || !commitPattern.test(manifest.commit)) errors.push('commit is missing or not a full object id');
  const unknown = (manifest.requiredCapabilities ?? []).filter((c) => !KNOWN_CAPABILITIES.has(c));
  if (unknown.length) errors.push(`unknown required capabilities: ${unknown.join(', ')}`);
  if (!Array.isArray(manifest.files)) errors.push('manifest lists no files');
  if (manifest.status && manifest.status !== 'complete') notes.push(`generation status is '${manifest.status}'`);
  if (errors.length) return { ok: false, errors, notes, manifest, manifestSha256: sha256 };
  const listed = new Set<string>();
  for (const f of manifest.files!) {
    listed.add(f.path);
    if (f.path.startsWith('/') || f.path.split('/').includes('..')) {
      errors.push(`listed path escapes the generation: ${f.path}`);
      continue;
    }
    const p = join(dir, f.path);
    if (!existsSync(p)) {
      errors.push(`missing file ${f.path}`);
      continue;
    }
    const size = statSync(p).size;
    if (size !== f.size) {
      errors.push(`size mismatch ${f.path}: ${size} != ${f.size}`);
      continue;
    }
    if ((await sha256File(p)) !== f.sha256) errors.push(`SHA-256 mismatch ${f.path}`);
  }
  const extra = listFiles(dir).filter((p) => !listed.has(p) && p !== 'manifest.json' && p !== 'run.json' && !p.startsWith('.devos-mcp'));
  if (extra.length) notes.push(`${extra.length} file(s) not listed in the manifest, ignored (first: ${extra[0]})`);
  return { ok: errors.length === 0, errors, notes, manifest, manifestSha256: sha256 };
}
