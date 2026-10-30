// Generation sources (PLAN M5, resolution rule 4). A source answers "which of these commits can you provide for this
// repository?" in one pass; materializing a hit gives folders on disk (local folders are already there, OCI hits are
// pulled into the cache first).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { normalizeRemote, type Workspace } from './git.ts';
import { readManifest } from '../generation/verify.ts';

export type SourceKind = 'local' | 'cache' | 'oci';

export interface Hit {
  source: SourceKind;
  commit: string;
  /** Where it comes from, for answers: a folder or an OCI reference. */
  origin: string;
  materialize(): Promise<{ dir: string; label: string }[]>;
}

export interface SourceResult {
  hits: Hit[];
  /** One line for `generation_info`: what was looked at. */
  summary: string;
  error?: string;
}

export interface GenerationSource {
  kind: SourceKind;
  find(ws: Workspace, commits: string[]): Promise<SourceResult>;
}

/** Same repository: equal normalized remotes, or one side has no remote (then the commit alone decides). */
export function sameRepository(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeRemote(a);
  const nb = normalizeRemote(b);
  return !na || !nb || na === nb;
}

interface Indexed {
  dir: string;
  commit: string;
  remote: string | null;
}

/** Folders that hold a `manifest.json`, at most `depth` levels below each root (the root itself included). */
function scan(root: string, depth: number, marker: string | null): Indexed[] {
  const out: Indexed[] = [];
  const visit = (dir: string, level: number) => {
    if (existsSync(join(dir, 'manifest.json')) && (!marker || existsSync(join(dir, marker)))) {
      const { manifest } = readManifest(dir);
      if (manifest && typeof manifest.commit === 'string') out.push({ dir, commit: manifest.commit, remote: manifest.repository?.remoteUrl ?? null });
      return;
    }
    if (level >= depth) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const p = join(dir, n);
      try {
        if (statSync(p).isDirectory()) visit(p, level + 1);
      } catch {
        /* unreadable entry: skip */
      }
    }
  };
  visit(root, 0);
  return out;
}

export const CACHE_MARKER = '.devos-mcp-origin.json';

/** Configured local folders (`kind: local`) or the OCI cache (`kind: cache`, only folders with a completed pull). */
export class FolderSource implements GenerationSource {
  kind: SourceKind;
  roots: string[];
  depth: number;

  constructor(kind: 'local' | 'cache', roots: string[], depth: number) {
    this.kind = kind;
    this.roots = roots;
    this.depth = depth;
  }

  async find(ws: Workspace, commits: string[]): Promise<SourceResult> {
    const wanted = new Set(commits);
    const roots = this.roots.filter((r) => existsSync(r));
    const all = roots.flatMap((r) => scan(r, this.depth, this.kind === 'cache' ? CACHE_MARKER : null));
    const hits: Hit[] = all
      .filter((g) => wanted.has(g.commit) && sameRepository(g.remote, ws.remoteUrl))
      .map((g) => ({
        source: this.kind,
        commit: g.commit,
        origin: g.dir,
        materialize: async () => [{ dir: g.dir, label: this.kind === 'cache' ? `${basename(g.dir)}@oci-cache` : basename(g.dir) }],
      }));
    const summary = `${this.kind}: ${roots.length ? roots.join(', ') : '(no folder)'}; ${all.length} generation(s) scanned, ${hits.length} for this repository within the candidate commits`;
    return { hits, summary };
  }
}
