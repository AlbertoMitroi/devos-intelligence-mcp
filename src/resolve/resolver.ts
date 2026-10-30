// Resolution of the generation(s) for the workspace (PLAN M5, resolution rules 3 to 8): nearest analyzed commit,
// local before cache before registry at equal distance, every generation verified before use.
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { candidates, changedSince, distanceTo, isAncestor, readWorkspace, type Workspace } from './git.ts';
import { FolderSource, type GenerationSource, type Hit, type SourceKind } from './sources.ts';
import { OciSource } from './oci.ts';
import { verifyGeneration, type Manifest } from '../generation/verify.ts';
import { IndexReader } from '../generation/index-reader.ts';

export interface Loaded {
  label: string;
  dir: string;
  source: SourceKind;
  origin: string;
  manifest: Manifest;
  manifestSha256: string;
  notes: string[];
  reader: IndexReader | null;
  readerError: string | null;
}

export interface Resolution {
  workspace: Workspace;
  /** Commit the loaded generations describe; null when nothing was found. */
  commit: string | null;
  /** Commits between `commit` and HEAD (first-parent steps within the window; `git rev-list --count` through `main`). */
  distance: number | null;
  /** True when the generation came from a moving `main` tag beyond the candidate window. */
  viaMain?: boolean;
  loaded: Loaded[];
  sources: string[];
  skipped: string[];
  errors: string[];
}

const ORDER: Record<SourceKind, number> = { local: 0, cache: 1, oci: 2 };

const verified = new Map<string, Promise<Awaited<ReturnType<typeof verifyGeneration>>>>();

function verifyOnce(dir: string) {
  let p = verified.get(dir);
  if (!p) {
    p = verifyGeneration(dir);
    verified.set(dir, p);
  }
  return p;
}

async function load(dir: string, label: string, hit: Pick<Hit, 'source' | 'origin'>): Promise<Loaded | string> {
  const v = await verifyOnce(dir);
  if (!v.ok) {
    verified.delete(dir);
    return `${label} (${hit.origin}): ${v.errors.slice(0, 3).join('; ')}${v.errors.length > 3 ? `; and ${v.errors.length - 3} more` : ''}`;
  }
  const opened = IndexReader.open(join(dir, 'index.sqlite'));
  return {
    label,
    dir,
    source: hit.source,
    origin: hit.origin,
    manifest: v.manifest!,
    manifestSha256: v.manifestSha256!,
    notes: v.notes,
    reader: opened.reader,
    readerError: opened.error,
  };
}

export class Resolver {
  cfg: Config;
  sources: GenerationSource[];
  oci: OciSource;
  cached: { key: string; resolution: Resolution; at: number } | null = null;

  constructor(cfg: Config, sources?: GenerationSource[], env: NodeJS.ProcessEnv = process.env) {
    this.cfg = cfg;
    this.oci = new OciSource(cfg, env);
    this.sources = sources ?? [
      new FolderSource('local', cfg.generationRoots, 1),
      new FolderSource('cache', [join(cfg.cacheDir, 'generations')], 3),
      this.oci,
    ];
  }

  /** Re-reads HEAD on every call; the resolution is reused while root and HEAD are unchanged. */
  async resolve(dir: string): Promise<Resolution | { error: string }> {
    const ws = readWorkspace(dir);
    if ('error' in ws) return ws;
    const key = `${ws.root}\0${ws.head}`;
    // A miss is retried after a minute (a CI run may have published the generation meanwhile).
    if (this.cached?.key === key && (this.cached.resolution.loaded.length > 0 || Date.now() - this.cached.at < 60000)) return this.cached.resolution;
    const resolution = await this.resolveFresh(ws);
    this.cached = { key, resolution, at: Date.now() };
    return resolution;
  }

  async resolveFresh(ws: Workspace): Promise<Resolution> {
    const commits = candidates(ws.root, this.cfg.maxAncestors);
    const results = await Promise.all(this.sources.map((s) => s.find(ws, commits)));
    const res: Resolution = { workspace: ws, commit: null, distance: null, loaded: [], sources: results.map((r) => r.summary), skipped: [], errors: results.flatMap((r) => (r.error ? [r.error] : [])) };
    const byCommit = new Map<string, Hit[]>();
    for (const h of results.flatMap((r) => r.hits)) byCommit.set(h.commit, [...(byCommit.get(h.commit) ?? []), h]);
    for (const [distance, commit] of commits.entries()) {
      const hits = (byCommit.get(commit) ?? []).sort((a, b) => ORDER[a.source] - ORDER[b.source]);
      if (hits.length === 0) continue;
      // The best source kind that yields at least one valid generation for this commit wins; others are not mixed in.
      for (const kind of ['local', 'cache', 'oci'] as SourceKind[]) {
        const group = hits.filter((h) => h.source === kind);
        if (group.length === 0) continue;
        const loaded = await this.materialize(group, res);
        if (loaded.length > 0) {
          res.commit = commit;
          res.distance = distance;
          res.loaded = loaded;
          return res;
        }
      }
    }
    await this.mainFallback(ws, res);
    return res;
  }

  async materialize(group: Hit[], res: Resolution): Promise<Loaded[]> {
    const out: Loaded[] = [];
    const labels = new Set<string>();
    for (const h of group) {
      let dirs: { dir: string; label: string }[];
      try {
        dirs = await h.materialize();
      } catch (e) {
        res.skipped.push(`${h.origin}: ${(e as Error).message}`);
        continue;
      }
      for (const d of dirs) {
        const l = await load(d.dir, d.label, h);
        if (typeof l === 'string') res.skipped.push(l);
        else {
          let label = l.label;
          for (let i = 2; labels.has(label); i++) label = `${l.label}-${i}`;
          labels.add(label);
          out.push({ ...l, label });
        }
      }
    }
    return out;
  }

  async mainFallback(ws: Workspace, res: Resolution): Promise<void> {
    try {
      const loaded: { l: Loaded; distance: number }[] = [];
      for (const main of await this.oci.main(ws)) {
        for (const d of main.dirs) {
          const l = await load(d.dir, d.label, { source: 'oci', origin: main.origin });
          if (typeof l === 'string') res.skipped.push(l);
          else if (!isAncestor(ws.root, l.manifest.commit)) res.skipped.push(`${main.origin}: commit ${l.manifest.commit.slice(0, 12)} is not a known ancestor of HEAD`);
          else loaded.push({ l, distance: distanceTo(ws.root, l.manifest.commit) });
        }
      }
      if (loaded.length) {
        loaded.sort((a, b) => a.distance - b.distance);
        res.commit = loaded[0].l.manifest.commit;
        res.distance = loaded[0].distance;
        res.viaMain = true;
        res.loaded = loaded.filter((x) => x.l.manifest.commit === res.commit).map((x) => x.l);
      }
    } catch (e) {
      res.errors.push(`oci main fallback: ${(e as Error).message}`);
    }
  }
}

export interface Freshness {
  exact: boolean;
  changed: Set<string>;
  dirty: boolean;
  /** One line every answer starts with. */
  header: string;
}

export function freshness(res: Resolution): Freshness {
  const ws = res.workspace;
  const head = ws.head.slice(0, 12);
  const gens = res.loaded.map((l) => `${l.label} (${l.manifest.engine?.name ?? 'engine?'} ${l.manifest.engine?.version ?? ''}, contract ${l.manifest.schemaVersion}${l.manifest.status && l.manifest.status !== 'complete' ? `, status ${l.manifest.status}` : ''})`.replace(' ,', ',')).join(' + ');
  const commit = res.commit!;
  const ch = changedSince(ws.root, commit);
  const exact = commit === ws.head;
  let header: string;
  if (exact) {
    header = `generation ${gens} at ${head}, exact match for HEAD`;
    if (ch.dirty) header += `; WARNING working tree has ${ch.files.size} uncommitted change(s), evidence in those files is marked [changed]`;
  } else {
    const dist = `${res.distance} commit(s) behind${res.viaMain ? ', found through the main tag' : ''}`;
    header = `WARNING generation ${gens} is for ${commit.slice(0, 12)}, the nearest analyzed ancestor of HEAD ${head} (${dist}); ${ch.known ? `${ch.files.size} file(s) changed since, evidence in them is marked [changed]` : 'files changed since are unknown (commit not in the local history)'}`;
  }
  return { exact, changed: ch.files, dirty: ch.dirty, header };
}
