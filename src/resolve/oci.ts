// OCI registry source (PLAN M6): registry HTTP API v2 over fetch, Bearer token challenge (anonymous for public
// packages, basic credentials when configured), digests checked, layers extracted with the own tar reader into the
// cache, then verified like any generation before the folder is published in the cache by an atomic rename.
// Tags (agreed with the release session): `<full sha>-<engine>` and the moving `main-<engine>`, one artifact per
// engine; a bare `<sha>` or `main` tag (several layers, one per engine) is read too.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Workspace } from './git.ts';
import { CACHE_MARKER, type GenerationSource, type Hit, type SourceResult } from './sources.ts';
import { extractTo, readTar } from './tar.ts';
import { verifyGeneration } from '../generation/verify.ts';

export const ARTIFACT_TYPE = 'application/vnd.devos.intelligence.generation.v1';
export const LAYER_TYPE = 'application/vnd.devos.intelligence.generation.v1.tar+gzip';
const ACCEPTED_LAYERS = [LAYER_TYPE, 'application/gzip', 'application/x-gzip', 'application/x-tar', 'application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.oci.image.layer.v1.tar'];
const MANIFEST_ACCEPT = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ');
export const ANNOTATION_MANIFEST_SHA = 'dev.devos.intelligence.manifest-sha256';
const ANNOTATION_TITLE = 'org.opencontainers.image.title';
const ANNOTATION_REVISION = 'org.opencontainers.image.revision';
const ANNOTATION_ENGINE = 'dev.devos.intelligence.engine';

/** `<sha>-<engine>` → engine; `<sha>` → ''; anything else → null. */
export function tagEngine(tag: string, commit: string): string | null {
  if (tag === commit) return '';
  return tag.startsWith(`${commit}-`) && /^[a-z0-9][a-z0-9._-]*$/.test(tag.slice(commit.length + 1)) ? tag.slice(commit.length + 1) : null;
}

export interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  annotations?: Record<string, string>;
}

export interface OciManifest {
  mediaType?: string;
  artifactType?: string;
  config?: Descriptor;
  layers: Descriptor[];
  annotations?: Record<string, string>;
}

/** `ghcr.io/{owner}/context-{repo}` with the workspace slug → base URL and repository name. */
export function parseReference(template: string, ws: Pick<Workspace, 'slug'>): { base: string; name: string; display: string } | null {
  if (!ws.slug) return null;
  let t = template.replace(/\{owner\}/g, ws.slug.owner).replace(/\{repo\}/g, ws.slug.name).toLowerCase();
  let scheme = 'https';
  const m = /^(https?):\/\//.exec(t);
  if (m) {
    scheme = m[1];
    t = t.slice(m[0].length);
  }
  const slash = t.indexOf('/');
  if (slash < 0) return null;
  return { base: `${scheme}://${t.slice(0, slash)}`, name: t.slice(slash + 1), display: t };
}

export class Registry {
  base: string;
  name: string;
  user: string | null;
  token: string | null;
  timeoutMs: number;
  bearer: string | null = null;

  constructor(base: string, name: string, opts: { user: string | null; token: string | null; timeoutMs: number }) {
    this.base = base;
    this.name = name;
    this.user = opts.user;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs;
  }

  async request(path: string, accept?: string): Promise<Response> {
    const url = path.startsWith('http') ? path : `${this.base}/v2/${this.name}${path}`;
    const go = () => {
      const headers: Record<string, string> = {};
      if (accept) headers.accept = accept;
      if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
      return fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    };
    let res = await go();
    if (res.status === 401 && !this.bearer) {
      await this.authenticate(res.headers.get('www-authenticate'));
      res = await go();
    }
    return res;
  }

  async authenticate(challenge: string | null): Promise<void> {
    if (!challenge || !/^bearer\s/i.test(challenge)) throw new Error(`registry asks for unsupported authentication: ${challenge ?? '(none)'}`);
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1].toLowerCase(), m[2]]));
    if (!params.realm) throw new Error('registry challenge without realm');
    const u = new URL(params.realm);
    if (params.service) u.searchParams.set('service', params.service);
    u.searchParams.set('scope', params.scope ?? `repository:${this.name}:pull`);
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Basic ${Buffer.from(`${this.user ?? 'token'}:${this.token}`).toString('base64')}`;
    const res = await fetch(u, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { token?: string; access_token?: string };
    this.bearer = body.token ?? body.access_token ?? null;
    if (!this.bearer) throw new Error('token response without token');
  }

  /** All tags (follows `Link` pagination). A missing repository gives an empty list. */
  async tags(): Promise<string[]> {
    const out: string[] = [];
    let next: string | null = '/tags/list?n=1000';
    for (let page = 0; next && page < 100; page++) {
      const res = await this.request(next);
      if (res.status === 404) return out;
      if (!res.ok) throw new Error(`tag list failed: HTTP ${res.status}`);
      const body = (await res.json()) as { tags?: string[] | null };
      out.push(...(body.tags ?? []));
      const link = res.headers.get('link');
      const m = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
      next = m ? (m[1].startsWith('http') ? m[1] : `${this.base}${m[1]}`) : null;
    }
    return out;
  }

  async manifest(reference: string): Promise<{ manifest: OciManifest; digest: string }> {
    const res = await this.request(`/manifests/${reference}`, MANIFEST_ACCEPT);
    if (!res.ok) throw new Error(`manifest ${reference}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const announced = res.headers.get('docker-content-digest');
    if (announced && announced.startsWith('sha256:') && announced !== digest) throw new Error(`manifest ${reference}: digest mismatch`);
    const manifest = JSON.parse(bytes.toString('utf8')) as OciManifest;
    if (!Array.isArray(manifest.layers)) throw new Error(`manifest ${reference}: not an image manifest (an index is not supported)`);
    return { manifest, digest };
  }

  async blob(d: Descriptor, maxBytes: number): Promise<Buffer> {
    if (d.size > maxBytes) throw new Error(`layer ${d.digest} is ${d.size} bytes, over the ${maxBytes} limit`);
    const res = await this.request(`/blobs/${d.digest}`);
    if (!res.ok) throw new Error(`blob ${d.digest}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length !== d.size) throw new Error(`blob ${d.digest}: size ${bytes.length} != ${d.size}`);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== d.digest) throw new Error(`blob ${d.digest}: digest mismatch (${digest})`);
    return bytes;
  }
}

/** Label of one pulled generation: `<repo>-<engine>` from the tag suffix, the engine annotation or the layer title. */
function layerLabel(display: string, tag: string, manifest: OciManifest, d: Descriptor, i: number, single: boolean): string {
  const repo = display.split('/').pop()!.replace(/^context-/, '');
  const fromTag = /^(?:[0-9a-f]{40}|main)-(.+)$/.exec(tag)?.[1];
  const engine = (single ? fromTag : undefined) ?? d.annotations?.[ANNOTATION_ENGINE] ?? (single ? manifest.annotations?.[ANNOTATION_ENGINE] : undefined);
  if (engine) return `${repo}-${engine.replace(/@.*$/, '').replace(/-intelligence$/, '')}`.replace(/[^\w.-]+/g, '_');
  const title = (d.annotations?.[ANNOTATION_TITLE] ?? `layer-${i}`).replace(/\.(tar\.gz|tgz|tar)$/, '');
  return `${repo}-${title}`.replace(/[^\w.-]+/g, '_');
}

function cacheKey(display: string): string {
  return display.replace(/[^\w.-]+/g, '__');
}

/**
 * Pulls one artifact into `<cache>/generations/<reference>/<commit>/<layer>/`. Each layer is extracted to a temporary
 * folder, verified (generation checks, commit, manifest SHA-256 annotation) and renamed into place.
 */
export async function pull(reg: Registry, display: string, tag: string, expectedCommit: string | null, cfg: Config): Promise<{ dir: string; label: string }[]> {
  const { manifest, digest } = await reg.manifest(tag);
  const layers = manifest.layers.filter((l) => ACCEPTED_LAYERS.includes(l.mediaType) || /\.tar(\+gzip)?$/.test(l.mediaType));
  if (layers.length === 0) throw new Error(`${display}:${tag}: no generation layer (artifactType ${manifest.artifactType ?? 'none'})`);
  const revision = manifest.annotations?.[ANNOTATION_REVISION] ?? null;
  if (expectedCommit && revision && revision !== expectedCommit) throw new Error(`${display}:${tag}: revision annotation ${revision} is not the requested ${expectedCommit}`);
  const commit = expectedCommit ?? revision;
  const out: { dir: string; label: string }[] = [];
  const errors: string[] = [];
  for (const [i, layer] of layers.entries()) {
    const label = layerLabel(display, tag, manifest, layer, i, layers.length === 1);
    try {
      const bytes = await reg.blob(layer, cfg.oci.maxBytes);
      const entries = readTar(bytes, cfg.oci.maxBytes);
      const tmp = join(cfg.cacheDir, 'tmp', `${Date.now()}-${randomBytes(4).toString('hex')}`);
      extractTo(entries, tmp);
      try {
        let root = tmp;
        if (!existsSync(join(tmp, 'manifest.json'))) {
          const tops = [...new Set(entries.map((e) => e.path.split('/')[0]))];
          if (tops.length === 1 && existsSync(join(tmp, tops[0], 'manifest.json'))) root = join(tmp, tops[0]);
        }
        const v = await verifyGeneration(root);
        if (!v.ok) throw new Error(`verification failed: ${v.errors.slice(0, 3).join('; ')}`);
        const actual = v.manifest!.commit;
        if (commit && actual !== commit) throw new Error(`generation commit ${actual} is not the requested ${commit}`);
        const want = layer.annotations?.[ANNOTATION_MANIFEST_SHA];
        if (want && want !== v.manifestSha256) throw new Error('manifest.json SHA-256 differs from the layer annotation');
        writeFileSync(join(root, CACHE_MARKER), JSON.stringify({ reference: `${display}:${tag}`, manifestDigest: digest, layerDigest: layer.digest, pulledAt: new Date().toISOString() }) + '\n');
        const dest = join(cfg.cacheDir, 'generations', cacheKey(display), actual, label);
        mkdirSync(join(dest, '..'), { recursive: true });
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
        renameSync(root, dest);
        out.push({ dir: dest, label });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
    }
  }
  if (out.length === 0) throw new Error(`${display}:${tag}: ${errors.join('; ')}`);
  return out;
}

export class OciSource implements GenerationSource {
  kind = 'oci' as const;
  cfg: Config;
  lastError: string | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  registryFor(ws: Workspace): { reg: Registry; display: string } | null {
    const ref = parseReference(this.cfg.oci.reference, ws);
    if (!ref) return null;
    return { reg: new Registry(ref.base, ref.name, { user: this.cfg.oci.user, token: this.cfg.oci.token, timeoutMs: this.cfg.oci.timeoutMs }), display: ref.display };
  }

  async find(ws: Workspace, commits: string[]): Promise<SourceResult> {
    if (!this.cfg.oci.enabled) return { hits: [], summary: 'oci: disabled (DEVOS_MCP_OCI=off)' };
    const r = this.registryFor(ws);
    if (!r) return { hits: [], summary: 'oci: no owner/repository in the remote URL, nothing to look up' };
    try {
      const tags = await r.reg.tags();
      const wanted = new Set(commits);
      const hits: Hit[] = [];
      for (const tag of tags) {
        const commit = /^[0-9a-f]{40}/.exec(tag)?.[0];
        if (!commit || !wanted.has(commit) || tagEngine(tag, commit) === null) continue;
        hits.push({ source: 'oci', commit, origin: `${r.display}:${tag}`, materialize: () => pull(r.reg, r.display, tag, commit, this.cfg) });
      }
      return { hits, summary: `oci: ${r.display}, ${tags.length} tag(s), ${hits.length} within the candidate commits` };
    } catch (e) {
      const error = `oci: ${r.display}: ${(e as Error).message}`;
      return { hits: [], summary: error, error };
    }
  }

  /** The moving `main` and `main-<engine>` tags, pulled; the caller decides whether their commits are ancestors of HEAD. */
  async main(ws: Workspace): Promise<{ dirs: { dir: string; label: string }[]; origin: string }[]> {
    if (!this.cfg.oci.enabled) return [];
    const r = this.registryFor(ws);
    if (!r) return [];
    const tags = (await r.reg.tags()).filter((t) => t === 'main' || /^main-[a-z0-9][a-z0-9._-]*$/.test(t));
    const out: { dirs: { dir: string; label: string }[]; origin: string }[] = [];
    for (const tag of tags.sort()) out.push({ dirs: await pull(r.reg, r.display, tag, null, this.cfg), origin: `${r.display}:${tag}` });
    return out;
  }
}
