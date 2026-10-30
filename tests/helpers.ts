// Test helpers: a synthetic generation in the contract layout with an `index.sqlite` in the Angular engine's schema,
// a Git repository with known commits, and a ustar writer for OCI layers.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, type Config } from '../src/config.ts';

export function tmp(prefix = 'mcp-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Same tables and indexes as devos-angular-intelligence `src/artifacts/sqlite.ts`. */
const SCHEMA = `
create table meta(key text primary key, value text not null);
create table entities(id text primary key, kind text, name text, container text, signature text, project text, origin text, json text);
create table declarations(id text primary key, entity text, context text, path text, line integer, col integer);
create table evidence(id text primary key, path text, line integer, col integer, end_line integer, end_col integer, method text, context text, text text);
create table relations(id text primary key, kind text, from_id text, to_id text, usage text, resolution text, context text, path text, line integer, declared_target text);
create table observations(id text primary key, kind text, project text, path text, line integer, json text);
create table links(id text primary key, kind text, via text, from_obs text, to_obs text, resolution text, reason text);
create table diagnostics(id text primary key, severity text, code text, scope text, state text, message text);
create table projects(id text primary key, record_type text, path text, json text);
create virtual table search using fts5(ref unindexed, kind unindexed, text);
`;

export const CTX = 'ctx:0001';
const P = 'ts:.:src/app';
export const IDS = {
  service: `${P}/orders.service#OrdersService`,
  load: `${P}/orders.service#OrdersService.load`,
  get: `${P}/orders.service#OrdersService.get`,
  list: `${P}/order-list#OrderList`,
  listInit: `${P}/order-list#OrderList.ngOnInit`,
  refresh: `${P}/order-list#OrderList.refresh`,
  other: `${P}/archive.service#ArchiveService.load`,
  repo: `${P}/repo#Repo`,
  sqlRepo: `${P}/repo#SqlRepo`,
  http: 'ts:pkg:@angular/common@22.2.3:types/http#HttpClient.get(string)',
};

export interface GenOptions {
  commit: string;
  remoteUrl?: string | null;
  engine?: string;
  index?: boolean;
  /** Extra references to OrdersService, to exercise pagination. */
  extraRefs?: number;
  requiredCapabilities?: string[];
  schemaVersion?: string;
}

export function writeGeneration(dir: string, o: GenOptions): string {
  mkdirSync(join(dir, 'graph'), { recursive: true });
  mkdirSync(join(dir, 'context', 'projects'), { recursive: true });
  const files: Record<string, string | Buffer> = {
    'graph/entities.ndjson': '',
    'context/overview.md': `# Overview: ${o.remoteUrl ?? 'local'}\n\nCommit \`${o.commit}\`.\n`,
    'context/projects/root.md': '# Project shop (`.`)\n\n## Routes\n\n- `/orders` (`src/app/app.routes.ts:4`)\n' + 'x'.repeat(7000) + '\n',
  };
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  if (o.index !== false) {
    const db = new DatabaseSync(join(dir, 'index.sqlite'));
    db.exec(SCHEMA);
    const ins = (t: string, ...v: (string | number | null)[]) => db.prepare(`insert into ${t} values (${v.map(() => '?').join(', ')})`).run(...v);
    ins('meta', 'commit', o.commit);
    ins('meta', 'engine', o.engine ?? 'angular-intelligence@0.1.0');
    const ent = (id: string, kind: string, name: string, container: string | null, sig: string, origin = 'source') => {
      ins('entities', id, kind, name, container, sig, '.', origin, '{}');
      ins('search', id, 'entity', `${name} ${sig} ${kind}`);
    };
    ent(IDS.service, 'class', 'OrdersService', `${P}/orders.service#`, 'class OrdersService');
    ent(IDS.load, 'method', 'load', IDS.service, 'load(): Observable<Order[]>');
    ent(IDS.get, 'method', 'get', IDS.service, 'get(id: string): Observable<Order>');
    ent(IDS.list, 'class', 'OrderList', `${P}/order-list#`, 'class OrderList implements OnInit');
    ent(IDS.listInit, 'method', 'ngOnInit', IDS.list, 'ngOnInit(): void');
    ent(IDS.refresh, 'method', 'refresh', IDS.list, 'refresh(): void');
    ent(IDS.other, 'method', 'load', `${P}/archive.service#ArchiveService`, 'load(): void');
    ent(IDS.repo, 'interface', 'Repo', `${P}/repo#`, 'interface Repo');
    ent(IDS.sqlRepo, 'class', 'SqlRepo', `${P}/repo#`, 'class SqlRepo implements Repo');
    ent(IDS.http, 'method', 'get', null, 'get(url: string)', 'metadata');
    const decl = (n: number, entity: string, path: string, line: number) => ins('declarations', `decl:${n}`, entity, CTX, path, line, 1);
    decl(1, IDS.service, 'src/app/orders.service.ts', 8);
    decl(2, IDS.load, 'src/app/orders.service.ts', 12);
    decl(3, IDS.get, 'src/app/orders.service.ts', 16);
    decl(4, IDS.list, 'src/app/order-list.ts', 5);
    decl(5, IDS.listInit, 'src/app/order-list.ts', 10);
    decl(6, IDS.refresh, 'src/app/order-list.ts', 14);
    decl(7, IDS.other, 'src/app/archive.service.ts', 3);
    decl(8, IDS.repo, 'src/app/repo.ts', 1);
    decl(9, IDS.sqlRepo, 'src/app/repo.ts', 5);
    let ev = 0;
    const evidence = (path: string, line: number, text: string) => {
      ins('evidence', `ev:${++ev}`, path, line, 1, line, 10, 'semantic', CTX, text);
      ins('search', `snip:${ev}`, 'snippet', text);
    };
    evidence('src/app/orders.service.ts', 13, "return this.http.get<Order[]>(`${environment.apiUrl}/v1/orders`);");
    evidence('src/app/orders.service.ts', 17, 'return this.http.get<Order>(`${this.base}/${id}`); // token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"');
    evidence('src/app/order-list.ts', 11, 'this.refresh();');
    evidence('src/app/order-list.ts', 15, 'this.orders.load().subscribe((o) => this.rows.set(o));');
    let rel = 0;
    const relation = (kind: string, from: string, to: string, usage: string | null, path: string, line: number) => ins('relations', `rel:${++rel}`, kind, from, to, usage, 'exact', CTX, path, line, null);
    relation('calls_declared_target', IDS.load, IDS.http, null, 'src/app/orders.service.ts', 13);
    relation('calls_declared_target', IDS.get, IDS.http, null, 'src/app/orders.service.ts', 17);
    relation('calls_declared_target', IDS.listInit, IDS.refresh, null, 'src/app/order-list.ts', 11);
    relation('calls_declared_target', IDS.refresh, IDS.load, null, 'src/app/order-list.ts', 15);
    relation('references', IDS.refresh, IDS.load, 'invocation', 'src/app/order-list.ts', 15);
    relation('references', IDS.list, IDS.service, 'read', 'src/app/order-list.ts', 7);
    for (let i = 0; i < (o.extraRefs ?? 0); i++) relation('references', IDS.list, IDS.service, 'read', 'src/app/order-list.ts', 100 + i);
    relation('implements', IDS.sqlRepo, IDS.repo, null, 'src/app/repo.ts', 5);
    relation('contains', IDS.service, IDS.load, null, 'src/app/orders.service.ts', 12);
    relation('contains', IDS.service, IDS.get, null, 'src/app/orders.service.ts', 16);
    const obs = (id: string, kind: string, path: string, line: number, json: Record<string, unknown>) => ins('observations', id, kind, '.', path, line, JSON.stringify({ id, kind, project: '.', context: CTX, ...json }));
    obs('obs:call1', 'http.call', 'src/app/orders.service.ts', 13, { method: 'GET', canonicalRoute: '/v1/orders', resolution: 'exact', caller: IDS.load, baseAddress: { key: 'environment.apiUrl', nameSource: 'configuration', source: 'environment' } });
    obs('obs:call2', 'http.call', 'src/app/orders.service.ts', 17, { method: 'GET', canonicalRoute: '/api/shop/v1/orders/{}', resolution: 'exact', caller: IDS.get });
    obs('obs:ep1', 'http.endpoint', 'src/Api/OrdersController.cs', 20, { method: 'GET', canonicalRoute: '/v1/orders', routeTemplate: '/v1/orders', handler: 'dotnet:src/Api/Api.csproj:M:Shop.Api.OrdersController.List' });
    obs('obs:route1', 'ui.route', 'src/app/app.routes.ts', 4, { path: '/orders', component: IDS.list, guards: {} });
    obs('obs:route2', 'ui.route', 'src/app/app.routes.ts', 5, { path: '/orders/:id', loadComponent: `${P}/order-detail#OrderDetail`, guards: { canActivate: [`${P}/auth#authGuard`] } });
    obs('obs:reg1', 'di.registers', 'src/app/orders.service.ts', 7, { service: IDS.service, implementation: IDS.service, lifetime: 'root' });
    obs('obs:con1', 'di.consumes', 'src/app/order-list.ts', 7, { service: IDS.service, consumer: IDS.list, via: 'inject' });
    obs('obs:con2', 'di.consumes', 'src/app/order-list.ts', 8, { service: IDS.repo, consumer: IDS.list, via: 'constructor' });
    ins('links', 'lnk:1', 'configured_route', 'http', 'obs:call1', 'obs:ep1', 'exact', null);
    ins('links', 'lnk:2', 'consumes_contract', 'di', 'obs:con1', 'obs:reg1', 'exact', null);
    ins('links', 'lnk:3', 'consumes_contract', 'di', 'obs:con2', null, 'unresolved', 'no provider of this token was found in the analysed code');
    db.close();
  }
  const listed = ['graph/entities.ndjson', 'context/overview.md', 'context/projects/root.md', ...(o.index !== false ? ['index.sqlite'] : [])];
  const manifest = {
    schemaVersion: o.schemaVersion ?? '1.1',
    commit: o.commit,
    status: 'complete',
    engine: { name: (o.engine ?? 'angular-intelligence@0.1.0').split('@')[0], version: '0.1.0' },
    repository: { remoteUrl: o.remoteUrl === undefined ? 'https://github.com/Example/shop.git' : o.remoteUrl },
    requiredCapabilities: o.requiredCapabilities ?? [],
    coverage: { summary: { total: 1, semantic: 1 } },
    files: listed.map((p) => {
      const b = readFileSync(join(dir, p));
      return { path: p, sha256: createHash('sha256').update(b).digest('hex'), size: b.length };
    }),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repository with `n` commits on main; returns its folder and the commits, oldest first. */
export function gitRepo(n: number, remote: string | null = 'git@github.com:Example/Shop.git', seed = ''): { dir: string; commits: string[] } {
  const dir = tmp('mcp-repo-');
  const g = (...a: string[]) => sh(dir, 'git', a);
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  g('config', 'commit.gpgsign', 'false');
  if (remote) g('remote', 'add', 'origin', remote);
  mkdirSync(join(dir, 'src/app'), { recursive: true });
  const commits: string[] = [];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, i === 0 ? 'src/app/orders.service.ts' : `src/app/file${i}.ts`), `// ${seed}${i}\n`);
    g('add', '-A');
    g('commit', '-q', '-m', `c${i}`);
    commits.push(g('rev-parse', 'HEAD'));
  }
  return { dir, commits };
}

export function testConfig(over: Omit<Partial<Config>, 'oci'> & { oci?: Partial<Config['oci']> } = {}): Config {
  const base = loadConfig({ HOME: tmp('mcp-home-'), DEVOS_MCP_OCI: 'off', DEVOS_MCP_GENERATIONS: '' });
  return { ...base, ...over, oci: { ...base.oci, ...(over.oci ?? {}) } };
}

/** ustar archive of a folder's files (or of explicit raw entries), gzip-compressed. */
export function tarGz(entries: { path: string; data?: Buffer; type?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const h = Buffer.alloc(512);
    h.write(e.path, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type ?? '0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function folderEntries(dir: string, files: string[]): { path: string; data: Buffer }[] {
  return files.map((p) => ({ path: `./${p}`, data: readFileSync(join(dir, p)) }));
}

export function write(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}
