import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Resolver, type Resolution } from '../../src/resolve/resolver.ts';
import { TOOLS, runTool } from '../../src/mcp/tools.ts';
import { IDS, gitRepo, sh, testConfig, tmp, writeGeneration } from '../helpers.ts';

async function setup(opts: { extraRefs?: number; index?: boolean; second?: boolean } = {}): Promise<Resolution> {
  const { dir, commits } = gitRepo(1);
  const folder = tmp();
  writeGeneration(join(folder, 'shop-angular'), { commit: commits[0], extraRefs: opts.extraRefs, index: opts.index });
  if (opts.second) writeGeneration(join(folder, 'shop-dotnet'), { commit: commits[0], engine: 'dotnet-intelligence@0.1.0', index: false });
  const res = await new Resolver(testConfig({ generationRoots: [folder] })).resolve(dir);
  assert.ok(!('error' in res));
  assert.ok(res.loaded.length > 0, res.skipped.join('; '));
  return res;
}

function call(res: Resolution, name: string, args: Record<string, unknown> = {}): string {
  const tool = TOOLS.find((t) => t.name === name)!;
  const out = runTool(tool, res, args);
  assert.ok(!out.isError, out.text);
  const [header, ...body] = out.text.split('\n');
  assert.match(header, /^generation shop-angular .* exact match for HEAD/);
  return body.join('\n');
}

test('tool list: fourteen tools with object schemas', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['generation_info', 'search', 'symbol', 'refs', 'callers', 'callees', 'implementations', 'di', 'routes', 'http', 'who_calls', 'messages', 'trace', 'context']);
  for (const t of TOOLS) assert.equal((t.inputSchema as { type: string }).type, 'object');
});

test('generation_info, symbol, ambiguity', async () => {
  const res = await setup();
  assert.match(call(res, 'generation_info'), /source local: .*shop-angular[\s\S]*index schema \(unversioned\), entities 10, relations/);
  const s = call(res, 'symbol', { symbol: 'OrdersService.load' });
  assert.match(s, /^method OrdersService.load\n  id ts:.:src\/app\/orders.service#OrdersService.load/);
  assert.match(s, /declared at src\/app\/orders.service.ts:12/);
  assert.match(s, /references 1, callers 1, callees 1, implementations 0/);
  assert.match(call(res, 'symbol', { symbol: 'OrdersService' }), /members \(2\): load, get/);
  const amb = call(res, 'symbol', { symbol: 'load' });
  assert.match(amb, /'load' is ambiguous \(2 candidates\); pass one id:/);
  assert.match(amb, /ArchiveService.load  src\/app\/archive.service.ts:3/);
  assert.match(call(res, 'symbol', { symbol: IDS.other }), /ArchiveService.load/);
  assert.match(call(res, 'symbol', { symbol: 'Nope' }), /no entity named 'Nope'/);
  assert.match(call(res, 'symbol', { symbol: 'get' }), /^method OrdersService.get/, 'source entities win over package ones');
});

test('refs paginate with a cursor; snippets are redacted', async () => {
  const res = await setup({ extraRefs: 30 });
  const p1 = call(res, 'refs', { symbol: 'OrdersService', limit: 10 });
  assert.match(p1, /1-10 of 31 references; more with cursor "10"/);
  const p4 = call(res, 'refs', { symbol: 'OrdersService', limit: 10, cursor: '30' });
  assert.match(p4, /31-31 of 31 references$/);
  const http = call(res, 'http', {});
  assert.match(http, /token = "<redacted>"/);
  assert.doesNotMatch(http, /AbCdEfGh/);
});

test('callers and callees follow depth', async () => {
  const res = await setup();
  const c = call(res, 'callers', { symbol: 'OrdersService.load', depth: 2 });
  assert.match(c, /OrderList.refresh  src\/app\/order-list.ts:15\n    this.orders.load\(\)/);
  assert.match(c, /\n  OrderList.ngOnInit  src\/app\/order-list.ts:11  \(via OrderList.refresh\)/);
  assert.match(c, /1-2 of 2 callers/, 'the call and the invocation reference at one place count once');
  assert.match(call(res, 'callees', { symbol: 'OrdersService.load' }), /@angular\/common HttpClient.get\(string\)  src\/app\/orders.service.ts:13/);
});

test('implementations, di, routes, http', async () => {
  const res = await setup();
  assert.match(call(res, 'implementations', { symbol: 'Repo' }), /implements  SqlRepo  src\/app\/repo.ts:5/);
  const di = call(res, 'di', { service: 'OrdersService' });
  assert.match(di, /consumes  OrdersService by OrderList via inject  src\/app\/order-list.ts:7  exact/);
  assert.match(di, /registers OrdersService  root  impl OrdersService  src\/app\/orders.service.ts:7/);
  assert.match(call(res, 'di', { service: 'Repo' }), /unresolved: no provider of this token/);
  assert.match(call(res, 'di'), /^registers OrdersService/);
  const routes = call(res, 'routes', {});
  assert.match(routes, /UI {3}\/orders {2}-> OrderList {2}src\/app\/app.routes.ts:4/);
  assert.match(routes, /UI {3}\/orders\/:id {2}-> lazy OrderDetail {2}guards canActivate: authGuard/);
  assert.match(routes, /HTTP GET \/v1\/orders {2}-> OrdersController.List/);
  assert.match(call(res, 'routes', { prefix: '/orders/{x}' }), /^UI {3}\/orders\/:id/);
  assert.match(call(res, 'http', { route: '/v1' }), /GET \/v1\/orders {2}exact {2}base environment.apiUrl \(configuration\) {2}caller OrdersService.load/);
});

test('who_calls: exact, suffix, links and callers of the calling method', async () => {
  const res = await setup();
  const w = call(res, 'who_calls', { route: 'GET /v1/orders' });
  assert.match(w, /served by GET \/v1\/orders -> OrdersController.List/);
  assert.match(w, /call GET \/v1\/orders .* caller OrdersService.load {2}src\/app\/orders.service.ts:13/);
  assert.match(w, /link configured_route exact -> GET \/v1\/orders OrdersController.List src\/Api\/OrdersController.cs:20/);
  assert.match(w, /called by OrderList.refresh {2}src\/app\/order-list.ts:15/);
  const s = call(res, 'who_calls', { route: '/v1/orders/:id', depth: 0 });
  assert.match(s, /\/api\/shop\/v1\/orders\/\{\} .*\(suffix match\)/);
  assert.match(call(res, 'who_calls', { route: '/nothing' }), /no HTTP call or endpoint matches/);
});

test('context lists cards and pages a long one', async () => {
  const res = await setup();
  assert.match(call(res, 'context'), /overview context\/overview.md[\s\S]*project {2}context\/projects\/root.md {2}Project shop \(`.`\) {2}\(project .\)/);
  const p1 = call(res, 'context', { project: '.' });
  assert.match(p1, /^context\/projects\/root.md\n# Project shop/);
  const next = /more with cursor "(\d+)"/.exec(p1)![1];
  const p2 = call(res, 'context', { project: 'shop', cursor: next });
  assert.doesNotMatch(p2, /more with cursor/);
  assert.match(call(res, 'context', { project: 'zzz' }), /no context pack matches/);
});

test('search: entities and snippets', async () => {
  const res = await setup();
  const s = call(res, 'search', { query: 'Orders' });
  assert.match(s, /entity class OrdersService {2}src\/app\/orders.service.ts:8\n {4}id ts:/);
  assert.match(call(res, 'search', { query: 'subscribe', kind: 'snippet' }), /snippet src\/app\/order-list.ts:15\n {4}this.orders.load\(\)/);
  assert.match(call(res, 'search', { query: 'qqqqq' }), /no matches/);
});

test('two generations of one commit; one without index', async () => {
  const res = await setup({ second: true });
  assert.equal(res.loaded.length, 2);
  const tool = TOOLS.find((t) => t.name === 'routes')!;
  const out = runTool(tool, res, {}).text;
  assert.match(out.split('\n')[0], /generation shop-angular .* \+ shop-dotnet \(dotnet-intelligence/);
  assert.match(out, /\[shop-dotnet\] this generation has no index.sqlite/);
  assert.match(out, /\[shop-angular\] UI {3}\/orders/);
  assert.match(runTool(tool, res, { generation: 'shop-angular' }).text, /\nUI {3}\/orders/);
  assert.equal(runTool(tool, res, { generation: 'nope' }).isError, true);
});

test('missing index: query tools explain, context still works', async () => {
  const res = await setup({ index: false });
  assert.match(call(res, 'symbol', { symbol: 'x' }), /no index.sqlite/);
  assert.match(call(res, 'context'), /context\/overview.md/);
  assert.match(call(res, 'generation_info'), /index this generation has no index.sqlite/);
});

test('answers after a commit on top of the generation carry the warning and [changed]', async () => {
  const res0 = await setup();
  const root = res0.workspace.root;
  sh(root, 'git', ['commit', '-q', '--allow-empty', '-m', 'empty']);
  sh(root, 'sh', ['-c', 'echo "// moved" >> src/app/orders.service.ts && git commit -qam edit']);
  const folder = join(res0.loaded[0].dir, '..');
  const res = await new Resolver(testConfig({ generationRoots: [folder] })).resolve(root);
  assert.ok(!('error' in res));
  const out = runTool(TOOLS.find((t) => t.name === 'callees')!, res, { symbol: 'OrdersService.load' }).text;
  assert.match(out.split('\n')[0], /^WARNING generation shop-angular .* \(2 commit\(s\) behind\); 1 file\(s\) changed since/);
  assert.match(out, /src\/app\/orders.service.ts:13 \[changed\]/);
});

async function setupDotnet(status?: string): Promise<Resolution> {
  const { dir, commits } = gitRepo(1);
  const folder = tmp();
  writeGeneration(join(folder, 'shop-angular'), { commit: commits[0], dotnetExtras: true, status });
  const res = await new Resolver(testConfig({ generationRoots: [folder] })).resolve(dir);
  assert.ok(!('error' in res));
  return res;
}

test('.NET index additions: per-usage refs, runtime targets, observation search, messages, indexSchema', async () => {
  const res = await setupDotnet();
  const refs = call(res, 'refs', { symbol: 'OrdersService' });
  assert.match(refs, /src\/app\/order-list.ts:7 {2}read {2}from OrderList\n {4}private readonly orders = inject\(OrdersService\);/);
  assert.match(refs, /src\/app\/order-list.ts:21 {2}read {2}from OrderList\n {4}OrdersService.cacheKey/);
  assert.match(refs, /1-2 of 2 references/, 'one row per usage evidence, not per relation');
  assert.match(call(res, 'callees', { symbol: 'OrderList.ngOnInit' }), /SqlRepo {2}src\/app\/order-list.ts:12 {2}\(possible runtime target\)/);
  assert.match(call(res, 'search', { query: 'endpoint', kind: 'observation' }), /^observation http.endpoint src\/Api\/OrdersController.cs:20\n {4}http.endpoint GET \/v1\/orders/);
  const m = call(res, 'messages');
  assert.match(m, /publish {2}OrderPlaced {2}kafka {2}topic orders.placed \(configuration\) {2}by OrdersService.load {2}src\/app\/orders.service.ts:20\n {2}link consumes_contract exact -> messaging.subscribe by ArchiveService.load src\/app\/archive.service.ts:9/, 'the site wins over the row location');
  assert.match(m, /subscribe Shop.Events.OrderPlaced {2}kafka/, 'a .NET contract object prints its full name');
  assert.match(call(res, 'messages', { contract: 'shop.events' }), /1-1 of 1 messaging facts/);
  assert.match(call(res, 'symbol', { symbol: 'OrdersService' }), /^class OrdersService/, 'the type wins over its constructor');
  assert.match(call(res, 'messages', { contract: 'nothing' }), /no publisher or subscriber matches 'nothing'/);
  assert.match(call(res, 'generation_info'), /index schema 1, entities/);
});

test('partial generation: an empty answer says absence is not proof', async () => {
  const res = await setupDotnet('partial');
  const tool = TOOLS.find((t) => t.name === 'routes')!;
  assert.match(runTool(tool, res, { prefix: '/nothing' }).text, /no routes under '\/nothing'\nnote: shop-angular is partial; an absence of results is not proof of absence/);
});

test('trace: open search to service-side observations, a target, the weakest link, errors', async () => {
  const res = await setupDotnet();
  const open = call(res, 'trace', { from: 'OrderList.ngOnInit' });
  assert.match(open, /^trace from OrderList.ngOnInit to service-side observations, depth 8\n/);
  assert.match(open, /\nhttp.endpoint GET \/v1\/orders {2}\(4 step\(s\), weakest link: step 1, exact\)\n {2}1\. calls_declared_target exact {2}OrderList.refresh {2}src\/app\/order-list.ts:11\n {2}2\. calls_declared_target exact {2}OrdersService.load {2}src\/app\/order-list.ts:15\n {2}3\. http.call exact {2}http.call GET \/v1\/orders {2}src\/app\/orders.service.ts:13\n {2}4\. link.configured_route exact {2}http.endpoint GET \/v1\/orders {2}src\/Api\/OrdersController.cs:20/);
  assert.match(open, /\nmessaging.subscribe Shop.Events.OrderPlaced {2}\(4 step\(s\)/);
  assert.match(call(res, 'trace', { from: 'OrderList.ngOnInit', to: 'SqlRepo' }), /\nSqlRepo {2}\(1 step\(s\), weakest link: step 1, candidate\)\n {2}1\. possible_runtime_target candidate {2}SqlRepo/);
  assert.match(call(res, 'trace', { from: 'OrderList.ngOnInit', to: 'obs:sub1' }), /\nmessaging.subscribe Shop.Events.OrderPlaced {2}\(4 step\(s\)/);
  assert.match(call(res, 'trace', { from: 'OrderList.ngOnInit', to: 'Repo' }), /no path within 8 steps/);
  assert.match(call(res, 'trace', { from: 'load' }), /'load' is ambiguous; pass one of:/);
  assert.match(call(res, 'trace', { from: 'OrderList.ngOnInit', depth: 2 }), /no service-side observation reachable within 2 steps/);
  const who = call(res, 'who_calls', { route: 'GET /v1/orders' });
  assert.match(who, /served by GET \/v1\/orders -> OrdersController.List {2}src\/Api\/OrdersController.cs:20\n {2}linked caller configured_route candidate: http.call GET \/api\/shop\/v1\/orders\/\{\} caller OrdersService.get {2}src\/app\/orders.service.ts:17/);
  assert.doesNotMatch(who, /linked caller .*\/v1\/orders caller OrdersService.load/, 'a caller matched by route is listed once, below');
});
