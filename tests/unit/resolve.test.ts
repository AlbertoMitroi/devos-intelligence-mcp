import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyGeneration } from '../../src/generation/verify.ts';
import { Resolver, freshness } from '../../src/resolve/resolver.ts';
import type { GenerationSource, Hit, SourceKind } from '../../src/resolve/sources.ts';
import { gitRepo, sh, testConfig, tmp, writeGeneration } from '../helpers.ts';

test('verification accepts a good generation and names every failure', async () => {
  const c = 'a'.repeat(40);
  const good = writeGeneration(tmp(), { commit: c });
  const ok = await verifyGeneration(good);
  assert.equal(ok.ok, true, ok.errors.join('; '));

  const tampered = writeGeneration(tmp(), { commit: c });
  appendFileSync(join(tampered, 'context/overview.md'), 'x');
  assert.match((await verifyGeneration(tampered)).errors.join(), /size mismatch context\/overview.md/);

  const sameSize = writeGeneration(tmp(), { commit: c });
  writeFileSync(join(sameSize, 'graph/entities.ndjson'), '');
  const m = JSON.parse(String(await import('node:fs').then((f) => f.readFileSync(join(sameSize, 'manifest.json')))));
  m.files[0].sha256 = '0'.repeat(64);
  writeFileSync(join(sameSize, 'manifest.json'), JSON.stringify(m));
  assert.match((await verifyGeneration(sameSize)).errors.join(), /SHA-256 mismatch graph\/entities.ndjson/);

  assert.match((await verifyGeneration(writeGeneration(tmp(), { commit: c, requiredCapabilities: ['time-travel'] }))).errors.join(), /unknown required capabilities: time-travel/);
  assert.match((await verifyGeneration(writeGeneration(tmp(), { commit: c, schemaVersion: '2.0' }))).errors.join(), /not major 1/);
  assert.match((await verifyGeneration(tmp())).errors.join(), /no manifest.json/);
  const extra = writeGeneration(tmp(), { commit: c });
  writeFileSync(join(extra, 'stray.txt'), 'x');
  const v = await verifyGeneration(extra);
  assert.equal(v.ok, true);
  assert.match(v.notes.join(), /not listed/);
});

class FakeSource implements GenerationSource {
  kind: SourceKind;
  dirs: Map<string, string[]>;
  calls = 0;
  constructor(kind: SourceKind, dirs: Record<string, string[]>) {
    this.kind = kind;
    this.dirs = new Map(Object.entries(dirs));
  }
  async find(_ws: unknown, commits: string[]) {
    const hits: Hit[] = commits.filter((c) => this.dirs.has(c)).map((c) => ({ source: this.kind, commit: c, origin: `${this.kind}:${c}`, materialize: async () => { this.calls++; return this.dirs.get(c)!.map((d, i) => ({ dir: d, label: `${this.kind}-${i}` })); } }));
    return { hits, summary: `${this.kind}: fake` };
  }
}

test('resolver: exact match wins; local wins a tie with the registry', async () => {
  const { dir, commits } = gitRepo(3);
  const head = commits[2];
  const local = new FakeSource('local', { [head]: [writeGeneration(tmp(), { commit: head })] });
  const oci = new FakeSource('oci', { [head]: [writeGeneration(tmp(), { commit: head })] });
  const r = new Resolver(testConfig(), [oci, local]);
  const res = await r.resolve(dir);
  assert.ok(!('error' in res));
  assert.equal(res.commit, head);
  assert.equal(res.distance, 0);
  assert.equal(res.loaded[0].source, 'local');
  assert.equal(oci.calls, 0, 'the registry is not pulled when a local generation answers');
  assert.match(freshness(res).header, /exact match for HEAD/);
});

test('resolver: nearest ancestor across sources, with the changed files', async () => {
  const { dir, commits } = gitRepo(4);
  const local = new FakeSource('local', { [commits[0]]: [writeGeneration(tmp(), { commit: commits[0] })] });
  const oci = new FakeSource('oci', { [commits[1]]: [writeGeneration(tmp(), { commit: commits[1] })] });
  const res = await new Resolver(testConfig(), [local, oci]).resolve(dir);
  assert.ok(!('error' in res));
  assert.equal(res.commit, commits[1]);
  assert.equal(res.distance, 2);
  const f = freshness(res);
  assert.equal(f.exact, false);
  assert.deepEqual([...f.changed].sort(), ['src/app/file2.ts', 'src/app/file3.ts']);
  assert.match(f.header, /^WARNING .* nearest analyzed ancestor .* \(2 commit\(s\) behind\); 2 file\(s\) changed since/);
});

test('resolver: a generation that fails verification is skipped for the next one', async () => {
  const { dir, commits } = gitRepo(2);
  const bad = writeGeneration(tmp(), { commit: commits[1], requiredCapabilities: ['x'] });
  const good = writeGeneration(tmp(), { commit: commits[0] });
  const res = await new Resolver(testConfig(), [new FakeSource('local', { [commits[1]]: [bad], [commits[0]]: [good] })]).resolve(dir);
  assert.ok(!('error' in res));
  assert.equal(res.commit, commits[0]);
  assert.match(res.skipped.join(), /unknown required capabilities: x/);
});

test('resolver: another repository with the same commit does not match; dirty tree is announced', async () => {
  const { dir, commits } = gitRepo(1);
  const foreign = writeGeneration(tmp(), { commit: commits[0], remoteUrl: 'https://github.com/Someone/Else.git' });
  const folder = tmp();
  sh(folder, 'cp', ['-R', foreign, join(folder, 'other')]);
  const cfg = testConfig({ generationRoots: [folder] });
  const none = await new Resolver(cfg).resolve(dir);
  assert.ok(!('error' in none));
  assert.equal(none.loaded.length, 0);
  sh(folder, 'cp', ['-R', writeGeneration(tmp(), { commit: commits[0], remoteUrl: 'https://github.com/example/shop' }), join(folder, 'mine')]);
  const res = await new Resolver(cfg).resolve(dir);
  assert.ok(!('error' in res));
  assert.equal(res.loaded.length, 1);
  assert.equal(res.loaded[0].label, 'mine');
  writeFileSync(join(dir, 'src/app/orders.service.ts'), '// edited\n');
  const f = freshness(res);
  assert.match(f.header, /exact match for HEAD; WARNING working tree has 1 uncommitted change/);
  assert.ok(f.changed.has('src/app/orders.service.ts'));
});

test('resolver: outside a repository and with nothing found', async () => {
  const r = new Resolver(testConfig(), []);
  const out = await r.resolve(tmp());
  assert.ok('error' in out);
  const { dir } = gitRepo(1);
  const res = await r.resolve(dir);
  assert.ok(!('error' in res) && res.loaded.length === 0);
});
