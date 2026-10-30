// Federation system generations (contract v1.2, system generation): the lab (5 repositories) and eShopOnAbp (one
// repository, two engines). The working copies are clones of the lab repositories at the commits the system
// generation was built from (its inputs.ndjson), so the system answers with an exact match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { Resolver, type Resolution } from '../../src/resolve/resolver.ts';
import { TOOLS, runTool } from '../../src/mcp/tools.ts';
import { ESHOP, ESHOP_COMMIT, GENERATIONS, LAB_LEASING, LAB_LEASING_REMOTE, LAB_WEB, LAB_WEB_REMOTE, cloneAt, skipUnless } from './env.ts';
import { tmp } from '../helpers.ts';

const LAB_SYSTEM = GENERATIONS ? join(GENERATIONS, 'lab-system') : '';
const ESHOP_SYSTEM = GENERATIONS ? join(GENERATIONS, 'eshoponabp-system') : '';

function inputCommit(system: string, id: string): string {
  return readFileSync(join(system, 'inputs.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.id === id).commit;
}

async function resolveAt(dir: string): Promise<Resolution> {
  const res = await new Resolver(loadConfig({ HOME: tmp('mcp-sys-home-'), DEVOS_MCP_GENERATIONS: GENERATIONS, DEVOS_MCP_OCI: 'off' })).resolve(dir);
  assert.ok(!('error' in res), 'error' in res ? res.error : '');
  return res;
}

function call(res: Resolution, name: string, args: Record<string, unknown> = {}): string {
  const out = runTool(TOOLS.find((t) => t.name === name)!, res, args);
  assert.equal(out.isError, false, out.text);
  return out.text;
}

const skipLab = skipUnless(GENERATIONS, LAB_WEB, LAB_LEASING) || (!existsSync(join(LAB_SYSTEM, 'manifest.json')) && 'no lab-system generation');

test('lab system from devos-lab-web: who_calls and trace reach the lab-leasing endpoint and its MediatR handler', { skip: skipLab, timeout: 60000 }, async () => {
  const res = await resolveAt(cloneAt(LAB_WEB, inputCommit(LAB_SYSTEM, 'web'), LAB_WEB_REMOTE));
  assert.deepEqual(res.loaded.map((g) => g.label), ['system:lab']);
  assert.deepEqual(res.loaded[0].system?.mine, ['web']);
  assert.match(call(res, 'routes').split('\n')[0], /^generation system:lab \(intelligence-federation [\d.]+, contract 1.2; inputs core, intake, leasing, pricing, web; this repository is input web, the others at their analyzed commits\) at [0-9a-f]{12}, exact match for HEAD$/);

  const who = call(res, 'who_calls', { route: 'POST /v1/leases/{id}/sign' });
  assert.match(who, /\nserved by POST \/v1\/leases\/\{flowId:guid\}\/sign -> LeasesController.Sign\(Guid,SignContractRequest,CancellationToken\) {2}\[leasing\] src\/Leasing.Host\/Controllers\/V1\/LeasesController.cs:\d+/);
  assert.match(who, /\ncall POST \/v1\/leases\/\{\}\/sign .* caller LeasesService.sign {2}\[web\] src\/app\/features\/leases\/leases.service.ts:\d+/);
  assert.match(who, /\n {2}link configured_route exact -> POST \/v1\/leases\/\{\}\/sign LeasesController.Sign\(.*\) \[leasing\] /);

  const trace = call(res, 'trace', { from: 'LeasesService.sign', to: 'UserTaskCommandHandlers' });
  assert.match(trace, /\nUserTaskCommandHandlers {2}\(6 step\(s\), weakest link: step \d, exact\)\n {2}1\. http.call exact {2}http.call POST \/v1\/leases\/\{\}\/sign {2}\[web\] [^\n]+\n {2}2\. link.configured_route exact {2}http.endpoint POST \/v1\/leases\/\{\}\/sign {2}\[leasing\] [^\n]+\n {2}3\. http.endpoint.handler exact {2}LeasesController.Sign[^\n]+\[leasing\][^\n]+\n {2}4\. inprocess.send exact {2}inprocess.send SignContractCommand {2}\[leasing\][^\n]+\n {2}5\. link.dispatches_to exact {2}inprocess.handler SignContractCommand {2}\[leasing\][^\n]+\n {2}6\. inprocess.handler.handler exact {2}UserTaskCommandHandlers {2}\[leasing\]/);

  // Repository tools stay on this repository's input unless asked for the system.
  assert.doesNotMatch(call(res, 'routes', { limit: 100 }), /\[leasing\]/);
  assert.match(call(res, 'routes', { limit: 100, scope: 'system' }), /\nHTTP POST \/v1\/leases\/\{flowId:guid\}\/sign {2}-> LeasesController.Sign.*\[leasing\]/);
  assert.match(call(res, 'symbol', { symbol: 'LeasesService' }), /\nclass LeasesService\n {2}id web\/ts:/);
});

test('lab system from devos-lab-leasing: Pricing.Client calls resolve into lab-pricing source with versionMatch', { skip: skipLab, timeout: 60000 }, async () => {
  const res = await resolveAt(cloneAt(LAB_LEASING, inputCommit(LAB_SYSTEM, 'leasing'), LAB_LEASING_REMOTE));
  assert.deepEqual(res.loaded[0].system?.mine, ['leasing']);
  const current = call(res, 'callees', { symbol: 'QuotePricingService.PriceAsync', limit: 100 });
  assert.match(current, /\nPricing.Client IPricingClient.CalculateQuoteAsync\(QuoteRequest,CancellationToken\) {2}\[leasing\] src\/Leasing.Pricing\/QuotePricingService.cs:\d+\n {4}implemented by IPricingClient.CalculateQuoteAsync\(QuoteRequest,CancellationToken\) {2}\[pricing\] src\/Pricing.Client\/IPricingClient.cs:\d+ {2}\(consumed 1.1.0, produced 1.1.0: versionMatch exact\)/);
  const backfill = 'leasing/dotnet:tools/Leasing.QuoteBackfill/Leasing.QuoteBackfill.csproj:M:Program.{Main}$(System.String[])';
  const old = call(res, 'callees', { symbol: backfill, limit: 100 });
  assert.match(old, /\nPricing.Client IPricingClient\.\w+\([^)]*\) {2}\[leasing\] tools\/Leasing.QuoteBackfill\/[^\n]+\n {4}implemented by IPricingClient\.\w+\([^)]*\) {2}\[pricing\] src\/Pricing.Client\/IPricingClient.cs:\d+ {2}\(consumed 1.0.0, produced 1.1.0: versionMatch different\)/);
});

test('lab system: SignalR flowUpdated from lab-leasing to the lab-web subscription', { skip: skipLab, timeout: 60000 }, async () => {
  const res = await resolveAt(cloneAt(LAB_LEASING, inputCommit(LAB_SYSTEM, 'leasing'), LAB_LEASING_REMOTE));
  const m = call(res, 'messages', { contract: 'flowUpdated' });
  assert.match(m, /\nargument "flowUpdated" for realtime.send method {2}in call to Lab.Core.MessageHubs IMessageHubUtility.SendToAll\(String,Object,CancellationToken\) {2}by FlowProjectionService.Project\(Guid,CancellationToken\) {2}\[leasing\] /);
  assert.match(m, /\npush {2}\(method from call-site argument 'method'\) .*\[core\] src\/Lab.Core.MessageHubs\/MessageHubUtility.cs:\d+\n {2}link pushes_to candidate -> realtime.subscribe flowUpdated by LeasingHubService \[web\] src\/app\/core\/realtime\/leasing-hub.service.ts:\d+/);
  const subscription = /listen {2}flowUpdated .*\[web\]/.exec(m);
  assert.ok(subscription, m);
  const trace = call(res, 'trace', { from: 'FlowProjectionService.Project', to: '.' });
  assert.match(trace, /\nrealtime.subscribe flowUpdated {2}\(5 step\(s\), weakest link: step 4, unresolved\)\n {2}1\. calls_declared_target exact {2}Lab.Core.MessageHubs IMessageHubUtility.SendToAll[^\n]+\[leasing\][^\n]+\n {2}2\. link.implemented_by_package exact {2}IMessageHubUtility.SendToAll[^\n]+\[core\][^\n]+\n {2}3\. implemented_by.implements candidate {2}MessageHubUtility`1.SendToAll[^\n]+\[core\][^\n]+\n {2}4\. realtime.send unresolved {2}realtime.send \(method from call-site argument 'method'\) {2}\[core\][^\n]+\n {2}5\. link.pushes_to candidate {2}realtime.subscribe flowUpdated {2}\[web\] src\/app\/core\/realtime\/leasing-hub.service.ts:\d+/);
});

test('eShopOnAbp system: one repository as two inputs, partial', { skip: skipUnless(GENERATIONS, ESHOP) || (!existsSync(join(ESHOP_SYSTEM, 'manifest.json')) && 'no eshoponabp-system generation'), timeout: 120000 }, async () => {
  const res = await resolveAt(cloneAt(ESHOP, ESHOP_COMMIT, 'https://github.com/abpframework/eShopOnAbp.git'));
  assert.deepEqual(res.loaded.map((g) => g.label), ['system:eshoponabp']);
  assert.deepEqual(res.loaded[0].system?.mine, ['angular', 'dotnet']);
  assert.match(call(res, 'generation_info').split('\n')[0], /status partial; inputs angular, dotnet; this repository is input angular and dotnet/);
  const http = call(res, 'http', { limit: 100 });
  assert.match(http, /\[angular\] apps\/angular\//);
  // Angular calls linked across the two inputs to the .NET endpoint (17 configured_route links in this system).
  const linked = call(res, 'who_calls', { route: 'POST /api/ordering/order/{id}/set-as-shipped' });
  assert.match(linked, /\nserved by POST \S+ -> \S+ {2}\[dotnet\] /);
  assert.match(linked, /\ncall POST \/api\/ordering\/order\/\{\}\/set-as-shipped .* {2}\[angular\] apps\/angular\/[^\n]+\n(?: {4}[^\n]+\n)? {2}link configured_route candidate -> POST \/api\/ordering\/order\/\{\}\/set-as-shipped \S+ \[dotnet\] /);
});
