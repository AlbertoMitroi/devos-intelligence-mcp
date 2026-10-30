// Real generations from ~/repos/devos/_generations against the repositories they were made from. Expected answers
// for lab-web come from devos-lab-web/ground-truth.yml (written from source, not from engine output).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { Resolver, type Resolution } from '../../src/resolve/resolver.ts';
import { TOOLS, runTool } from '../../src/mcp/tools.ts';
import { canonicalRoute } from '../../src/format.ts';
import { ESHOP, ESHOP_COMMIT, GENERATIONS, LAB_WEB, LAB_WEB_COMMIT, LAB_WEB_REMOTE, cloneAt, git, skipUnless } from './env.ts';
import { tmp } from '../helpers.ts';

const cfg = () => loadConfig({ HOME: tmp('mcp-it-home-'), DEVOS_MCP_GENERATIONS: GENERATIONS, DEVOS_MCP_OCI: 'off' });

async function resolveAt(dir: string): Promise<Resolution> {
  const res = await new Resolver(cfg()).resolve(dir);
  assert.ok(!('error' in res), 'error' in res ? res.error : '');
  return res;
}

function call(res: Resolution, name: string, args: Record<string, unknown> = {}): string {
  const out = runTool(TOOLS.find((t) => t.name === name)!, res, args);
  assert.equal(out.isError, false, out.text);
  return out.text;
}

test('lab-web at the analyzed commit: exact match and ground-truth answers', { skip: skipUnless(GENERATIONS, LAB_WEB) }, async () => {
  const dir = cloneAt(LAB_WEB, LAB_WEB_COMMIT, LAB_WEB_REMOTE);
  const res = await resolveAt(dir);
  assert.equal(res.loaded.length, 1);
  assert.equal(res.loaded[0].label, 'lab-web-angular');
  assert.equal(res.distance, 0);
  assert.match(call(res, 'generation_info'), /^generation lab-web-angular \(angular-intelligence 0.1.0, contract 1.1\) at e21eef1712b2, exact match for HEAD/);

  // web-http-calls: every service call of the ground truth is listed with its method, route and caller.
  const truth = readFileSync(join(LAB_WEB, 'ground-truth.yml'), 'utf8');
  const calls = [...truth.matchAll(/- "(\w+)\.(\w+): (GET|POST|PUT|PATCH|DELETE) \{apiUrl\}(\S+)/g)];
  assert.ok(calls.length >= 10, `ground truth parsed: ${calls.length} calls`);
  const http = call(res, 'http', { limit: 100 });
  for (const [, svc, method, verb, route] of calls) {
    const want = `${verb} ${canonicalRoute(route).route}`;
    assert.ok(http.split('\n').some((l) => l.startsWith(want + ' ') && l.includes(`caller ${svc}.${method} `)), `${want} from ${svc}.${method}\n${http}`);
  }
  assert.match(http, /of 15 HTTP calls$/);

  // web-routes: the full paths of the routes table.
  const routes = call(res, 'routes', { limit: 100 });
  for (const p of ['/applications', '/applications/:flowId', '/assessments', '/quotes/:flowId', '/leases/:flowId', '/admin/portfolio']) {
    assert.match(routes, new RegExp(`\\nUI {3}${p.replace(/[/:]/g, (c) => '\\' + c)} {2}-> `), p);
  }

  const who = call(res, 'who_calls', { route: 'POST /v1/quotes/{flowId}/accept' });
  assert.match(who, /call POST \/v1\/quotes\/\{\}\/accept .* caller QuotesService.accept {2}src\/app\/features\/quotes\/quotes.service.ts:\d+/);
  assert.match(who, /called by QuoteDetail\.\w+/);
  assert.match(call(res, 'di', { service: 'QuotesService' }), /registers QuotesService {2}root/);
  assert.match(call(res, 'context', { project: 'QuotesService' }), /# Service QuotesService/);
});

test('lab-web two commits ahead: nearest ancestor with a warning in every answer', { skip: skipUnless(GENERATIONS, LAB_WEB) }, async () => {
  const dir = cloneAt(LAB_WEB, LAB_WEB_COMMIT, LAB_WEB_REMOTE);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
  const service = join(dir, 'src/app/features/leases/leases.service.ts');
  writeFileSync(service, '// moved down\n' + readFileSync(service, 'utf8'));
  git(dir, 'commit', '-q', '-am', 'edit the leases service');
  const res = await resolveAt(dir);
  assert.equal(res.commit, LAB_WEB_COMMIT);
  assert.equal(res.distance, 2);
  for (const tool of ['routes', 'http', 'context'] as const) {
    assert.match(call(res, tool).split('\n')[0], /^WARNING generation lab-web-angular .* is for e21eef1712b2, the nearest analyzed ancestor of HEAD [0-9a-f]{12} \(2 commit\(s\) behind\); 1 file\(s\) changed since/);
  }
  assert.match(call(res, 'http', { route: '/v1/leases' }), /src\/app\/features\/leases\/leases.service.ts:\d+ \[changed\]/);
  assert.match(call(res, 'http', { route: '/v1/quotes' }), /quotes.service.ts:\d+\n/, 'unchanged files are not marked');
});

test('eShopOnAbp: two generations of one commit (Angular with index, .NET without)', { skip: skipUnless(GENERATIONS, ESHOP) }, async () => {
  const dir = cloneAt(ESHOP, ESHOP_COMMIT, 'https://github.com/abpframework/eShopOnAbp.git');
  const res = await resolveAt(dir);
  assert.deepEqual(res.loaded.map((g) => g.label).sort(), ['eshoponabp-angular', 'eshoponabp-dotnet']);
  const routes = call(res, 'routes', { limit: 100 });
  assert.match(routes, /\[eshoponabp-angular\] UI {3}\//);
  const dotnet = res.loaded.find((g) => g.label === 'eshoponabp-dotnet')!;
  if (!dotnet.reader) assert.match(routes, /\[eshoponabp-dotnet\] this generation has no index.sqlite/);
  else assert.match(routes, /\[eshoponabp-dotnet\] HTTP (GET|POST)/);
  assert.match(call(res, 'http', { generation: 'eshoponabp-angular', limit: 100 }), /of 17 HTTP calls$/);
  assert.match(call(res, 'context'), /\[eshoponabp-dotnet\] overview/);
});

test('every lab and reference generation verifies', { skip: skipUnless(GENERATIONS) }, async () => {
  const { verifyGeneration } = await import('../../src/generation/verify.ts');
  const names = ['eshop-dotnet', 'eshoponabp-angular', 'eshoponabp-dotnet', 'lab-core-dotnet', 'lab-intake-dotnet', 'lab-leasing-dotnet', 'lab-pricing-dotnet', 'lab-web-angular'];
  for (const n of names) {
    const v = await verifyGeneration(join(GENERATIONS, n));
    assert.ok(v.ok, `${n}: ${v.errors.join('; ')}`);
  }
});
