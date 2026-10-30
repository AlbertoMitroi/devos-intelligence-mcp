// Generation sources (PLAN M5, resolution rule 4). A source answers "which of these commits can you provide for this
// repository?" in one pass; materializing a hit gives folders on disk (local folders are already there, OCI hits are
// pulled into the cache first).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { normalizeRemote, type Workspace } from './git.ts';
import { readManifest } from '../generation/verify.ts';

export type SourceKind = 'local' | 'cache' | 'oci';

export interface Hit {
  source: SourceKind;
  commit: string;
  /** Where it comes from, for answers: a folder or an OCI reference. */
  origin: string;
  /** Set for a system generation: the input that is this repository; `commit` is that input's commit. */
  system?: { name: string; inputs: string[] };
  materialize(): Promise<{ dir: string; label: string }[]>;
}

/** One input of a system generation, from its `inputs.ndjson` (a file the manifest lists, so it is verified). */
export interface SystemInput {
  id: string;
  commit: string;
  remoteUrl: string | null;
  engine: string | null;
  included: boolean;
}

export function readSystemInputs(dir: string): SystemInput[] {
  try {
    return readFileSync(join(dir, 'inputs.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => {
      const r = JSON.parse(l);
      return { id: r.id, commit: r.commit, remoteUrl: r.repository?.remoteUrl ?? null, engine: r.engine ? `${r.engine.name}@${r.engine.version}` : null, included: r.included !== false };
    });
  } catch {
    return [];
  }
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
  /** A system generation: its name and inputs. */
  system?: { name: string; inputs: SystemInput[] };
}

/** Folders that hold a `manifest.json`, at most `depth` levels below each root (the root itself included). */
function scan(root: string, depth: number, marker: string | null): Indexed[] {
  const out: Indexed[] = [];
  const visit = (dir: string, level: number) => {
    if (existsSync(join(dir, 'manifest.json')) && (!marker || existsSync(join(dir, marker)))) {
      const { manifest } = readManifest(dir);
      if (manifest?.generationType === 'system') out.push({ dir, commit: manifest.commit, remote: null, system: { name: String(manifest.system ?? basename(dir)), inputs: readSystemInputs(dir) } });
      else if (manifest && typeof manifest.commit === 'string') out.push({ dir, commit: manifest.commit, remote: manifest.repository?.remoteUrl ?? null });
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

  /** `auto`: every system generation found; `off`: none; a folder: only that one. */
  systems: string;

  constructor(kind: 'local' | 'cache', roots: string[], depth: number, systems = 'auto') {
    this.kind = kind;
    this.roots = systems !== 'auto' && systems !== 'off' && kind === 'local' ? [...roots, systems] : roots;
    this.depth = depth;
    this.systems = systems;
  }

  async find(ws: Workspace, commits: string[]): Promise<SourceResult> {
    const wanted = new Set(commits);
    const roots = this.roots.filter((r) => existsSync(r));
    const all = roots.flatMap((r) => scan(r, this.depth, this.kind === 'cache' ? CACHE_MARKER : null));
    const seen = new Set<string>();
    const unique = all.filter((g) => (seen.has(g.dir) ? false : (seen.add(g.dir), true)));
    // A system applies when one of its included inputs is this repository (same remote, required on both sides) at a
    // candidate commit; system.yml is not needed: the generation's own verified inputs say what it contains.
    const systemHits: Hit[] = [];
    const mine = normalizeRemote(ws.remoteUrl);
    for (const g of unique.filter((x) => x.system)) {
      if (this.systems === 'off' || (this.systems !== 'auto' && g.dir !== this.systems.replace(/\/+$/, ''))) continue;
      // One repository can be several inputs (one per engine, eShopOnAbp); they share its commit.
      const inputs = g.system!.inputs.filter((i) => i.included && mine && normalizeRemote(i.remoteUrl) === mine && wanted.has(i.commit));
      if (inputs.length === 0) continue;
      const label = `system:${g.system!.name}`;
      systemHits.push({ source: this.kind, commit: inputs[0].commit, origin: g.dir, system: { name: g.system!.name, inputs: inputs.filter((i) => i.commit === inputs[0].commit).map((i) => i.id) }, materialize: async () => [{ dir: g.dir, label }] });
    }
    const hits: Hit[] = unique
      .filter((g) => !g.system && wanted.has(g.commit) && sameRepository(g.remote, ws.remoteUrl))
      .map((g) => ({
        source: this.kind,
        commit: g.commit,
        origin: g.dir,
        materialize: async () => [{ dir: g.dir, label: this.kind === 'cache' ? `${basename(g.dir)}@oci-cache` : basename(g.dir) }],
      }));
    hits.push(...systemHits);
    const systems = unique.filter((g) => g.system).length;
    const summary = `${this.kind}: ${roots.length ? roots.join(', ') : '(no folder)'}; ${unique.length} generation(s) scanned${systems ? ` (${systems} system)` : ''}, ${hits.length - systemHits.length} for this repository within the candidate commits${systemHits.length ? `, ${systemHits.length} system generation(s) with this repository as input` : ''}`;
    return { hits, summary };
  }
}
