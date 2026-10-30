// OCI round trip against a real registry (registry:2) where scripts/verify.sh pushed lab-web-angular with ORAS in the
// agreed layout: tag `<sha>-angular`, artifactType and layer media type of the release session, annotations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { Resolver } from '../../src/resolve/resolver.ts';
import { TOOLS, runTool } from '../../src/mcp/tools.ts';
import { LAB_WEB, LAB_WEB_COMMIT, LAB_WEB_REMOTE, REGISTRY, cloneAt, git } from './env.ts';
import { tmp } from '../helpers.ts';

const skip = !REGISTRY || !LAB_WEB || !existsSync(LAB_WEB) ? 'DEVOS_IT_REGISTRY and DEVOS_IT_LAB_WEB not set (scripts/verify.sh sets them)' : false;

test('registry: pull, verify, cache, answer; then answer from the cache with the registry unreachable', { skip, timeout: 60000 }, async () => {
  const dir = cloneAt(LAB_WEB, LAB_WEB_COMMIT, LAB_WEB_REMOTE);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'one ahead');
  const home = tmp('mcp-oci-home-');
  // Per-repository artifacts only: the system test below covers context-systems in the same registry.
  const env = { HOME: home, DEVOS_MCP_GENERATIONS: '', DEVOS_MCP_SYSTEM: 'off', DEVOS_MCP_OCI_REFERENCE: `${REGISTRY}/{owner}/context-{repo}` };
  const res = await new Resolver(loadConfig(env)).resolve(dir);
  assert.ok(!('error' in res));
  assert.equal(res.loaded.length, 1, [...res.sources, ...res.skipped, ...res.errors].join('\n'));
  const g = res.loaded[0];
  assert.equal(g.source, 'oci');
  assert.equal(g.label, 'devos-lab-web-angular');
  assert.match(g.origin, new RegExp(`context-devos-lab-web:${LAB_WEB_COMMIT}-angular$`));
  assert.equal(res.distance, 1);
  assert.ok(existsSync(join(g.dir, '.devos-mcp-origin.json')));
  const out = runTool(TOOLS.find((t) => t.name === 'who_calls')!, res, { route: 'POST /v1/leases/{id}/sign' }).text;
  assert.match(out, /^WARNING generation devos-lab-web-angular .* \(1 commit\(s\) behind\)/);
  assert.match(out, /call POST \/v1\/leases\/\{\}\/sign .* caller LeasesService.sign/);

  const offline = await new Resolver(loadConfig({ ...env, DEVOS_MCP_OCI_REFERENCE: 'http://127.0.0.1:9/{owner}/context-{repo}' })).resolve(dir);
  assert.ok(!('error' in offline));
  assert.equal(offline.loaded[0]?.source, 'cache', offline.sources.join('\n'));
  assert.equal(offline.loaded[0].label, 'devos-lab-web-angular@oci-cache');
  assert.match(offline.errors.join(), /oci: 127.0.0.1:9/);
});

test('registry: main-angular is used when no commit in the window has a tag', { skip, timeout: 60000 }, async () => {
  const dir = cloneAt(LAB_WEB, LAB_WEB_COMMIT, LAB_WEB_REMOTE);
  for (let i = 0; i < 3; i++) git(dir, 'commit', '-q', '--allow-empty', '-m', `ahead ${i}`);
  const res = await new Resolver(loadConfig({ HOME: tmp('mcp-oci-home-'), DEVOS_MCP_GENERATIONS: '', DEVOS_MCP_SYSTEM: 'off', DEVOS_MCP_MAX_ANCESTORS: '1', DEVOS_MCP_OCI_REFERENCE: `${REGISTRY}/{owner}/context-{repo}` })).resolve(dir);
  assert.ok(!('error' in res));
  assert.equal(res.commit, LAB_WEB_COMMIT, [...res.sources, ...res.skipped, ...res.errors].join('\n'));
  assert.equal(res.viaMain, true);
  assert.equal(res.distance, 3);
});

test('registry: the lab system generation from context-systems answers across repositories', { skip, timeout: 120000 }, async () => {
  const dir = cloneAt(LAB_WEB, LAB_WEB_COMMIT, LAB_WEB_REMOTE);
  const env = { HOME: tmp('mcp-oci-home-'), DEVOS_MCP_GENERATIONS: '', DEVOS_MCP_OCI_REFERENCE: `${REGISTRY}/{owner}/context-{repo}`, DEVOS_MCP_OCI_SYSTEMS_REFERENCE: `${REGISTRY}/{owner}/context-systems` };
  const res = await new Resolver(loadConfig(env)).resolve(dir);
  assert.ok(!('error' in res));
  assert.deepEqual(res.loaded.map((g) => [g.label, g.source, g.system?.mine]), [['system:lab', 'oci', ['web']]], [...res.sources, ...res.skipped, ...res.errors].join('\n'));
  assert.match(res.loaded[0].origin, new RegExp(`context-systems:lab\\.devos-lab-web\\.${LAB_WEB_COMMIT}$`));
  const out = runTool(TOOLS.find((t) => t.name === 'who_calls')!, res, { route: 'POST /v1/leases/{id}/sign' }).text;
  assert.match(out, /^generation system:lab .* exact match for HEAD\n/);
  assert.match(out, /\nserved by POST \/v1\/leases\/\{flowId:guid\}\/sign -> LeasesController.Sign.* {2}\[leasing\] /);
});
