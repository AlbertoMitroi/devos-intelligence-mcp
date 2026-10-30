import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRoute, page, routeMatch, shortName } from '../../src/format.ts';
import { redact, snippet } from '../../src/redact.ts';
import { normalizeRemote, slugOf } from '../../src/resolve/git.ts';
import { readTar, safePath } from '../../src/resolve/tar.ts';
import { sameRepository } from '../../src/resolve/sources.ts';
import { parseReference, tagEngine } from '../../src/resolve/oci.ts';
import { tarGz } from '../helpers.ts';

test('remote URLs normalize to host/owner/name in lower case', () => {
  const want = 'github.com/albertomitroi/devos-lab-web';
  for (const u of ['https://github.com/AlbertoMitroi/devos-lab-web.git', 'git@github.com:AlbertoMitroi/devos-lab-web.git', 'ssh://git@github.com:22/AlbertoMitroi/devos-lab-web', 'https://user@github.com/AlbertoMitroi/devos-lab-web/']) {
    assert.equal(normalizeRemote(u), want, u);
  }
  assert.deepEqual(slugOf('git@github.com:Owner/Repo.git'), { host: 'github.com', owner: 'owner', name: 'repo' });
  assert.equal(normalizeRemote(null), null);
  assert.ok(sameRepository('https://github.com/a/b', 'git@github.com:A/B.git'));
  assert.ok(!sameRepository('https://github.com/a/b', 'https://github.com/a/c'));
  assert.ok(sameRepository(null, 'https://github.com/a/c'), 'a side without a remote matches on commit only');
});

test('routes canonicalize like the contract and match exactly or by suffix', () => {
  assert.deepEqual(canonicalRoute('GET /v1/Leases/{flowId:guid}/'), { method: 'GET', route: '/v1/leases/{}' });
  assert.equal(canonicalRoute('/orders/:id?x=1').route, '/orders/{}');
  assert.equal(canonicalRoute('https://api.example.com/files/{*path}').route, '/files/{**}');
  assert.equal(canonicalRoute('/a/{id?}').route, '/a/{?}');
  assert.equal(canonicalRoute('/a/${id}').route, '/a/{}');
  assert.equal(routeMatch('/v1/orders', '/v1/orders'), 'exact');
  assert.equal(routeMatch('/api/shop/v1/orders/{}', '/v1/orders/{}'), 'suffix');
  assert.equal(routeMatch('/v1/orders/{}', '/api/shop/v1/orders/{}'), 'suffix');
  assert.equal(routeMatch('/v1/orders', '/v1/order'), null);
  assert.equal(routeMatch('/v1/orders', '/'), null);
});

test('short names stay resolvable', () => {
  assert.equal(shortName('ts:.:src/app/x/leases.service#LeasesService.search'), 'LeasesService.search');
  assert.equal(shortName('ts:pkg:@angular/core@22.2.3:index#OnInit'), '@angular/core OnInit');
  assert.equal(shortName('ts:.:src/app/features/leases/lease-detail#'), 'module src/app/features/leases/lease-detail');
  assert.equal(shortName('dotnet:src/A/A.csproj:M:Ns.Sub.LeasesController.Get(System.Guid,System.Threading.CancellationToken)'), 'LeasesController.Get(Guid,CancellationToken)');
  assert.equal(shortName('dotnet:src/A/A.csproj:T:Ns.Sub.LeasesController'), 'LeasesController');
  assert.equal(shortName('dotnet:pkg:Pricing.Client@1.1.0:Pricing.Client:T:Pricing.Client.IPricingClient'), 'Pricing.Client IPricingClient');
  assert.equal(shortName(null), '(none)');
});

test('pages carry totals and a next cursor', () => {
  const p = page([1, 2, 3, 4, 5], 2, 2);
  assert.deepEqual(p, { items: [3, 4], total: 5, offset: 2, next: '4' });
  assert.equal(page([1, 2], 5, 0).next, null);
});

test('redaction hides credentials and keeps code and Git ids', () => {
  assert.equal(redact('const password = "hunter2";'), 'const password = "<redacted>";');
  assert.equal(redact("apiKey: 'abc123'"), "apiKey: '<redacted>'");
  assert.equal(redact('https://user:pw@host/x'), 'https://<redacted>@host/x');
  assert.equal(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'), 'Authorization: Bearer <redacted>');
  assert.equal(redact('k = AKIAxY7sQ2pLm9Zr4Tt6Wv8Nn3Bb5Cc1Dd0Ee'), 'k = <redacted>');
  assert.equal(redact('commit e21eef1712b25463d61687efc2f547d9dc0949f1'), 'commit e21eef1712b25463d61687efc2f547d9dc0949f1');
  const code = "import { X } from './features/v1/applications/application-list-component';";
  assert.equal(redact(code), code);
  assert.equal(snippet('  a\n   b  '), 'a b');
  assert.equal(snippet('x'.repeat(300)).length, 160);
});

test('tar reader accepts files and folders, refuses escapes and links', () => {
  const good = readTar(tarGz([{ path: './', type: '5' }, { path: './manifest.json', data: Buffer.from('{}') }, { path: './graph/', type: '5' }]), 1e6);
  assert.deepEqual(good.map((e) => [e.path, e.type]), [['manifest.json', 'file'], ['graph', 'dir']]);
  assert.throws(() => readTar(tarGz([{ path: '../evil', data: Buffer.from('x') }]), 1e6), /unsafe path/);
  assert.throws(() => readTar(tarGz([{ path: '/etc/passwd', data: Buffer.from('x') }]), 1e6), /absolute path/);
  assert.throws(() => readTar(tarGz([{ path: 'link', type: '2' }]), 1e6), /unsupported entry type '2'/);
  assert.throws(() => safePath('a//b'), /unsafe/);
  assert.throws(() => readTar(tarGz([{ path: 'big', data: Buffer.alloc(4096) }]), 1000), /Cannot create a Buffer|exceeds|buffer/i);
});

test('OCI references and tags', () => {
  const ws = { slug: { host: 'github.com', owner: 'albertomitroi', name: 'devos-lab-web' } };
  assert.deepEqual(parseReference('ghcr.io/{owner}/context-{repo}', ws), { base: 'https://ghcr.io', name: 'albertomitroi/context-devos-lab-web', display: 'ghcr.io/albertomitroi/context-devos-lab-web' });
  assert.equal(parseReference('http://localhost:5000/{owner}/context-{repo}', ws)!.base, 'http://localhost:5000');
  assert.equal(parseReference('ghcr.io/{owner}/context-{repo}', { slug: null }), null);
  const c = 'e21eef1712b25463d61687efc2f547d9dc0949f1';
  assert.equal(tagEngine(`${c}-angular`, c), 'angular');
  assert.equal(tagEngine(c, c), '');
  assert.equal(tagEngine(`${c}x`, c), null);
});
