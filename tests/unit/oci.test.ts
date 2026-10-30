// OCI source against an in-process registry that speaks the distribution API v2 subset the server uses, with a
// Bearer token challenge like GHCR. The real registry:2 and ORAS round trip is in tests/integration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resolver } from '../../src/resolve/resolver.ts';
import { ARTIFACT_TYPE, LAYER_TYPE, type OciManifest } from '../../src/resolve/oci.ts';
import { folderEntries, gitRepo, tarGz, testConfig, tmp, writeGeneration } from '../helpers.ts';

const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

interface FakeRegistry {
  url: string;
  server: Server;
  requests: string[];
  push(name: string, tag: string, layer: Buffer, annotations?: Record<string, string>, layerAnnotations?: Record<string, string>): void;
  corrupt(digest: string): void;
}

async function fakeRegistry(): Promise<FakeRegistry> {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, Buffer>();
  const tags = new Map<string, Set<string>>();
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/token') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token: 'T0K' }));
      return;
    }
    if (req.headers.authorization !== 'Bearer T0K') {
      res.statusCode = 401;
      res.setHeader('www-authenticate', `Bearer realm="http://${req.headers.host}/token",service="fake",scope="repository:x:pull"`);
      res.end();
      return;
    }
    const m = /^\/v2\/(.+)\/(tags\/list|manifests\/([^/]+)|blobs\/(sha256:[0-9a-f]+))$/.exec(url.pathname);
    const name = m?.[1] ?? '';
    if (m?.[2] === 'tags/list') {
      if (!tags.has(name)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.end(JSON.stringify({ name, tags: [...tags.get(name)!] }));
      return;
    }
    const body = m?.[3] ? manifests.get(`${name}:${m[3]}`) : m?.[4] ? blobs.get(m[4]) : undefined;
    if (!body) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (m?.[3]) {
      res.setHeader('content-type', 'application/vnd.oci.image.manifest.v1+json');
      res.setHeader('docker-content-digest', sha(body));
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    requests,
    push(name, tag, layer, annotations = {}, layerAnnotations = {}) {
      blobs.set(sha(layer), layer);
      const empty = Buffer.from('{}');
      blobs.set(sha(empty), empty);
      const manifest: OciManifest = {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        artifactType: ARTIFACT_TYPE,
        config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: sha(empty), size: 2 },
        layers: [{ mediaType: LAYER_TYPE, digest: sha(layer), size: layer.length, annotations: { 'org.opencontainers.image.title': 'generation.tar.gz', ...layerAnnotations } }],
        annotations,
      };
      manifests.set(`${name}:${tag}`, Buffer.from(JSON.stringify(manifest)));
      tags.set(name, new Set([...(tags.get(name) ?? []), tag]));
    },
    corrupt(digest) {
      const b = blobs.get(digest)!;
      const c = Buffer.from(b);
      c[c.length - 1] ^= 1;
      blobs.set(digest, c);
    },
  };
}

function layerOf(commit: string, extraRefs = 0): { layer: Buffer; manifestSha: string } {
  const g = writeGeneration(tmp(), { commit, extraRefs });
  const files = ['manifest.json', 'graph/entities.ndjson', 'context/overview.md', 'context/projects/root.md', 'index.sqlite'];
  return { layer: tarGz(folderEntries(g, files)), manifestSha: createHash('sha256').update(readFileSync(join(g, 'manifest.json'))).digest('hex') };
}

test('OCI: nearest ancestor tag is pulled, verified, cached, then served from the cache offline', async () => {
  const reg = await fakeRegistry();
  try {
    const { dir, commits } = gitRepo(3);
    const { layer, manifestSha } = layerOf(commits[1]);
    reg.push('example/context-shop', `${commits[1]}-angular`, layer, { 'org.opencontainers.image.revision': commits[1] }, { 'dev.devos.intelligence.manifest-sha256': manifestSha });
    reg.push('example/context-shop', `${commits[0]}-angular`, layerOf(commits[0]).layer);
    const cache = tmp();
    const cfg = testConfig({ cacheDir: cache, oci: { enabled: true, reference: `${reg.url}/{owner}/context-{repo}` } });
    const res = await new Resolver(cfg).resolve(dir);
    assert.ok(!('error' in res));
    assert.equal(res.commit, commits[1], res.skipped.join('; ') + res.errors.join('; '));
    assert.equal(res.distance, 1);
    assert.equal(res.loaded[0].source, 'oci');
    assert.equal(res.loaded[0].label, 'shop-angular');
    assert.ok(res.loaded[0].dir.startsWith(join(cache, 'generations')), res.loaded[0].dir);
    assert.ok(existsSync(join(res.loaded[0].dir, '.devos-mcp-origin.json')));
    assert.ok(reg.requests.some((r) => r.startsWith('GET /token')), 'the Bearer challenge was answered');

    reg.server.close();
    const offline = await new Resolver(cfg).resolve(dir);
    assert.ok(!('error' in offline));
    assert.equal(offline.commit, commits[1]);
    assert.equal(offline.loaded[0].source, 'cache');
    assert.equal(offline.loaded[0].label, 'shop-angular@oci-cache');
    assert.match(offline.errors.join(), /oci: .*fetch failed|ECONNREFUSED/);
  } finally {
    reg.server.close();
  }
});

test('OCI: a corrupted layer, a wrong revision or a wrong manifest digest is refused', async () => {
  const reg = await fakeRegistry();
  try {
    const { dir, commits } = gitRepo(1);
    const { layer } = layerOf(commits[0]);
    reg.push('example/context-shop', `${commits[0]}-angular`, layer);
    reg.push('example/context-shop', `${commits[0]}-dotnet`, layerOf(commits[0]).layer, { 'org.opencontainers.image.revision': 'b'.repeat(40) });
    reg.push('example/context-shop', `${commits[0]}-other`, layerOf(commits[0], 1).layer, {}, { 'dev.devos.intelligence.manifest-sha256': 'c'.repeat(64) });
    reg.corrupt(sha(layer)); // after the pushes: the angular and dotnet layers have identical bytes, so they share one blob
    const cfg = testConfig({ cacheDir: tmp(), oci: { enabled: true, reference: `${reg.url}/{owner}/context-{repo}` } });
    const res = await new Resolver(cfg).resolve(dir);
    assert.ok(!('error' in res));
    assert.equal(res.loaded.length, 0);
    const skipped = res.skipped.join('\n');
    assert.match(skipped, /-angular: .*digest mismatch/);
    assert.match(skipped, /-other: .*manifest.json SHA-256 differs from the layer annotation/);
    assert.match(skipped, /-dotnet: .*revision annotation b{40} is not the requested/);
  } finally {
    reg.server.close();
  }
});

test('OCI: main-<engine> fallback when no candidate commit has a tag, only if it is an ancestor', async () => {
  const reg = await fakeRegistry();
  try {
    const { dir, commits } = gitRepo(4);
    reg.push('example/context-shop', 'main-angular', layerOf(commits[0]).layer, { 'org.opencontainers.image.revision': commits[0] });
    const cfg = testConfig({ cacheDir: tmp(), maxAncestors: 1, oci: { enabled: true, reference: `${reg.url}/{owner}/context-{repo}` } });
    const res = await new Resolver(cfg).resolve(dir);
    assert.ok(!('error' in res));
    assert.equal(res.commit, commits[0], res.skipped.join('; '));
    assert.equal(res.distance, 3);
    assert.equal(res.viaMain, true);

    const other = gitRepo(1, 'git@github.com:Example/Shop.git', 'unrelated');
    const r2 = await new Resolver(cfg).resolve(other.dir);
    assert.ok(!('error' in r2));
    assert.equal(r2.loaded.length, 0);
    assert.match(r2.skipped.join(), /is not a known ancestor of HEAD/);
  } finally {
    reg.server.close();
  }
});
