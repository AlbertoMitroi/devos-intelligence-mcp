import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Resolver } from '../../src/resolve/resolver.ts';
import { TOOLS, runTool } from '../../src/mcp/tools.ts';
import { gitRepo, sh, testConfig, tmp, writeGeneration, writeSystem } from '../helpers.ts';

const SHOP = 'https://github.com/example/shop.git';
const API = 'https://github.com/example/api.git';
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

test('system: chosen by its inputs; replaces the per-repository generation at the same commit', async () => {
  const { dir, commits } = gitRepo(1);
  const folder = tmp();
  writeGeneration(join(folder, 'shop-angular'), { commit: commits[0] });
  writeSystem(join(folder, 'shop-system'), 'shop', [{ id: 'web', remote: SHOP, commit: commits[0] }, { id: 'api', remote: API, commit: 'a'.repeat(40) }]);
  writeSystem(join(folder, 'other-system'), 'other', [{ id: 'x', remote: API, commit: commits[0] }]);
  const res = await new Resolver(testConfig({ generationRoots: [folder] })).resolve(dir);
  assert.ok(!('error' in res));
  assert.deepEqual(res.loaded.map((g) => g.label), ['system:shop']);
  assert.deepEqual(res.loaded[0].system?.mine, ['web']);
  assert.equal(res.loaded[0].system?.secondary, false);
  const info = runTool(tool('generation_info'), res, {}).text;
  assert.match(info, /^generation system:shop \(intelligence-federation 0.1.0, contract 1.2; inputs web, api; this repository is input web, the others at their analyzed commits\) at [0-9a-f]{12}, exact match for HEAD/);
  assert.match(info, /\n {4}input api: https:\/\/github.com\/example\/api.git at aaaaaaaaaaaa/);

  const off = await new Resolver(testConfig({ generationRoots: [folder], system: 'off' })).resolve(dir);
  assert.ok(!('error' in off));
  assert.deepEqual(off.loaded.map((g) => g.label), ['shop-angular']);
});

test('system: a nearer per-repository generation answers; the system is kept for cross-repository tools', async () => {
  const { dir, commits } = gitRepo(2);
  const folder = tmp();
  writeGeneration(join(folder, 'shop-angular'), { commit: commits[1] });
  writeSystem(join(folder, 'shop-system'), 'shop', [{ id: 'web', remote: SHOP, commit: commits[0] }]);
  const res = await new Resolver(testConfig({ generationRoots: [folder] })).resolve(dir);
  assert.ok(!('error' in res));
  assert.deepEqual(res.loaded.map((g) => [g.label, g.system?.secondary ?? null]), [['shop-angular', null], ['system:shop', true]]);
  const routes = runTool(tool('routes'), res, {}).text;
  assert.match(routes, /exact match for HEAD; cross-repository answers \(who_calls, trace, messages\) from system:shop .* 1 commit\(s\) behind HEAD\nHTTP GET \/v1\/orders/);
  assert.match(runTool(tool('who_calls'), res, { route: '/v1/orders' }).text, /\n\[system:shop\] this generation has no index.sqlite/, 'who_calls answers from the system');
  assert.match(runTool(tool('routes'), res, { generation: 'system:shop' }).text, /no index.sqlite/);
});

test('system: a repository that is several inputs (one per engine); a workspace without remote matches no system', async () => {
  const { dir, commits } = gitRepo(1);
  const folder = tmp();
  writeSystem(join(folder, 'shop-system'), 'shop', [{ id: 'angular', remote: SHOP, commit: commits[0] }, { id: 'dotnet', remote: SHOP, commit: commits[0] }]);
  const res = await new Resolver(testConfig({ generationRoots: [folder] })).resolve(dir);
  assert.ok(!('error' in res));
  assert.deepEqual(res.loaded[0].system?.mine, ['angular', 'dotnet']);
  sh(dir, 'git', ['remote', 'remove', 'origin']);
  const none = await new Resolver(testConfig({ generationRoots: [folder] })).resolve(dir);
  assert.ok(!('error' in none));
  assert.equal(none.loaded.length, 0);
});
