// The MCP tools (PLAN, Tools). Every answer starts with the freshness header, lists `file:line` evidence with one-line
// redacted snippets, and is bounded by `limit` and `cursor`. Several loaded generations are queried together and each
// item is tagged with its generation label.
import { canonicalRoute, limitOf, loc, offsetOf, page, pageFooter, routeMatch, shortName } from '../format.ts';
import { snippet } from '../redact.ts';
import { findPack, listPacks, readPack } from '../generation/context-packs.ts';
import type { Row } from '../generation/index-reader.ts';
import { freshness, type Freshness, type Loaded, type Resolution } from '../resolve/resolver.ts';

export interface ToolContext {
  res: Resolution;
  fresh: Freshness;
  gens: Loaded[];
  args: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(ctx: ToolContext): string;
}

const common = {
  generation: { type: 'string', description: 'Only this generation (label or engine name) when several are loaded; see generation_info.' },
};
const paging = {
  limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Items per page (default 20, max 100).' },
  cursor: { type: 'string', description: 'Opaque cursor from the previous page.' },
};
const symbolArg = { type: 'string', description: 'Entity id, exact name, or qualified tail such as `LeasesService.search`.' };

function schema(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: { ...props, ...common }, required, additionalProperties: false };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

interface Item {
  g: Loaded;
  lines: string[];
}

/** Items of all generations, paged together; the label prefixes each item only when several generations are loaded. */
function render(ctx: ToolContext, items: Item[], noun: string, empty: string): string {
  const p = page(items, limitOf(ctx.args.limit), offsetOf(ctx.args.cursor));
  if (p.total === 0) return empty;
  const multi = ctx.gens.length > 1;
  const body = p.items.map((it) => (multi ? [`[${it.g.label}] ${it.lines[0]}`, ...it.lines.slice(1)] : it.lines).join('\n'));
  return [...body, pageFooter(p, noun)].join('\n');
}

function withIndex(ctx: ToolContext, fn: (g: Loaded) => Item[]): { items: Item[]; notes: string[] } {
  const items: Item[] = [];
  const notes: string[] = [];
  for (const g of ctx.gens) {
    if (!g.reader) notes.push(`[${g.label}] ${g.readerError}`);
    else items.push(...fn(g));
  }
  return { items, notes };
}

function join(notes: string[], text: string): string {
  return [...notes, text].filter(Boolean).join('\n');
}

const quote = (text: unknown) => {
  const s = snippet(text);
  return s ? `    ${s}` : null;
};

function lines(...xs: (string | null | undefined)[]): string[] {
  return xs.filter((x): x is string => !!x);
}

/** Resolves a symbol in each generation; returns per generation either the entity or a message. */
function resolveEach(ctx: ToolContext, term: string): { found: { g: Loaded; e: Row }[]; messages: string[] } {
  const found: { g: Loaded; e: Row }[] = [];
  const messages: string[] = [];
  const multi = ctx.gens.length > 1;
  for (const g of ctx.gens) {
    const tag = multi ? `[${g.label}] ` : '';
    if (!g.reader) {
      messages.push(`${tag}${g.readerError}`);
      continue;
    }
    const m = g.reader.resolveSymbol(term);
    if ('entity' in m) found.push({ g, e: m.entity });
    else if ('candidates' in m) {
      const decl = (id: string) => g.reader!.firstDeclaration(id);
      messages.push(`${tag}'${term}' is ambiguous (${m.total}${m.total > 10 ? '+' : ''} candidates); pass one id:`);
      for (const c of m.candidates) {
        const d = decl(c.id);
        messages.push(`  ${c.kind} ${c.id}${d ? `  ${loc(d.path, d.line, ctx.fresh.changed)}` : ''}`);
      }
    } else messages.push(`${tag}${m.none}`);
  }
  // A symbol found in one generation is enough; "not found" from the others is noise then.
  return { found, messages: found.length > 0 ? messages.filter((x) => !/no entity named/.test(x)) : messages };
}

function edgesOf(g: Loaded, id: string, direction: 'callers' | 'callees'): Row[] {
  const r = g.reader!;
  const dir = direction === 'callers' ? 'to' : 'from';
  const rows = [...r.relations(['calls_declared_target'], dir, id), ...r.relations(['references'], dir, id, 'invocation')];
  const seen = new Set<string>();
  return rows.filter((x) => {
    const k = `${direction === 'callers' ? x.from_id : x.to_id}|${x.path}|${x.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const generationInfo: ToolDef = {
  name: 'generation_info',
  description: 'Which generation answers for this repository: workspace, HEAD, source, commit (exact or nearest analyzed ancestor), engine, contract version, coverage, counts, verification, context packs, and the sources tried. Call it first when answers look stale or empty.',
  inputSchema: schema({}),
  run(ctx) {
    const { res, fresh } = ctx;
    const ws = res.workspace;
    const out: string[] = [
      `workspace ${ws.root}`,
      `HEAD ${ws.head}${fresh.dirty ? ' (working tree has uncommitted changes)' : ''}`,
      `remote ${ws.remoteUrl ?? '(none)'}`,
      `resolved commit ${res.commit}${fresh.exact ? ' (HEAD)' : ` (${res.distance} commit(s) behind HEAD${res.viaMain ? ', through the main tag' : ''})`}; ${fresh.changed.size} file(s) changed since`,
    ];
    for (const g of ctx.gens) {
      const m = g.manifest;
      const cov = m.coverage?.summary ? Object.entries(m.coverage.summary).map(([k, v]) => `${k} ${v}`).join(', ') : 'n/a';
      const counts = g.reader ? Object.entries(g.reader.counts()).map(([k, v]) => `${k} ${v}`).join(', ') : g.readerError;
      const packs = listPacks(g.dir, m);
      out.push(
        '',
        `generation ${g.label}`,
        `  source ${g.source}: ${g.origin}`,
        `  engine ${m.engine?.name ?? '?'} ${m.engine?.version ?? ''}, contract ${m.schemaVersion}, status ${m.status ?? '?'}, commit ${m.commit}`,
        `  verified: manifest SHA-256 ${g.manifestSha256.slice(0, 16)}..., ${m.files?.length ?? 0} listed files checked${g.notes.length ? `; notes: ${g.notes.join('; ')}` : ''}`,
        `  coverage ${cov}`,
        `  index ${counts}`,
        `  context packs ${packs.length}${packs.length ? `: ${packs.slice(0, 8).map((p) => p.project ?? p.path.replace(/^context\//, '')).join(', ')}${packs.length > 8 ? ', ...' : ''}` : ''}`,
      );
    }
    out.push('', 'sources tried:', ...res.sources.map((s) => `  ${s}`));
    if (res.skipped.length) out.push('skipped:', ...res.skipped.map((s) => `  ${s}`));
    if (res.errors.length) out.push('errors:', ...res.errors.map((s) => `  ${s}`));
    return out.join('\n');
  },
};

const search: ToolDef = {
  name: 'search',
  description: 'Full-text search over entity names and signatures and over redacted code snippets of the generation. Returns kind, compact name or file:line, and one line of text.',
  inputSchema: schema({ query: { type: 'string', description: 'Words to match (prefix match from 3 characters).' }, kind: { type: 'string', enum: ['entity', 'snippet'] }, ...paging }, ['query']),
  run(ctx) {
    const q = str(ctx.args.query);
    if (!q) return 'missing query';
    const kind = str(ctx.args.kind);
    const want = offsetOf(ctx.args.cursor) + limitOf(ctx.args.limit);
    let total = 0;
    const { items, notes } = withIndex(ctx, (g) => {
      const r = g.reader!;
      const { rows, total: t } = r.search(q, kind, want, 0);
      total += t;
      return rows.map((x) => {
        if (x.kind === 'entity') {
          const e = r.entity(x.ref);
          const d = r.firstDeclaration(x.ref);
          return { g, lines: lines(`entity ${e?.kind ?? ''} ${shortName(x.ref)}  ${d ? loc(d.path, d.line, ctx.fresh.changed) : '(no declaration: package symbol)'}`, `    id ${x.ref}`) };
        }
        const ev = r.one('select path, line from evidence where text = ? order by path, line limit 1', x.text);
        return { g, lines: lines(`snippet ${ev ? loc(ev.path, ev.line, ctx.fresh.changed) : x.ref}`, quote(x.text)) };
      });
    });
    // Each generation returned at most `want` rows; page over the merged list but report the true total.
    const p = page(items, limitOf(ctx.args.limit), offsetOf(ctx.args.cursor));
    if (p.total === 0) return join(notes, `no matches for '${q}'`);
    const multi = ctx.gens.length > 1;
    const body = p.items.map((it) => (multi ? [`[${it.g.label}] ${it.lines[0]}`, ...it.lines.slice(1)] : it.lines).join('\n'));
    const next = p.offset + p.items.length < total ? String(p.offset + p.items.length) : null;
    return join(notes, [...body, pageFooter({ ...p, total, next }, 'matches')].join('\n'));
  },
};

const symbol: ToolDef = {
  name: 'symbol',
  description: 'One entity: kind, signature, container, declarations (file:line), members, and how many references, callers, callees and implementations it has.',
  inputSchema: schema({ symbol: symbolArg }, ['symbol']),
  run(ctx) {
    const term = str(ctx.args.symbol);
    if (!term) return 'missing symbol';
    const { found, messages } = resolveEach(ctx, term);
    const out = [...messages];
    for (const { g, e } of found) {
      const r = g.reader!;
      const decls = r.declarations(e.id);
      const members = r.relations(['contains'], 'from', e.id);
      const tag = ctx.gens.length > 1 ? `[${g.label}] ` : '';
      out.push(
        `${tag}${e.kind} ${shortName(e.id)}`,
        `  id ${e.id}`,
        `  signature ${snippet(e.signature, 200)}`,
        e.container ? `  container ${shortName(e.container)}` : '',
        e.project ? `  project ${e.project}` : '',
        `  origin ${e.origin}`,
        ...decls.slice(0, 5).map((d) => `  declared at ${loc(d.path, d.line, ctx.fresh.changed)}`),
        decls.length > 5 ? `  ... ${decls.length - 5} more declarations` : '',
        `  references ${r.countRelations(['references'], 'to', e.id)}, callers ${edgesOf(g, e.id, 'callers').length}, callees ${edgesOf(g, e.id, 'callees').length}, implementations ${r.countRelations(['implements', 'inherits', 'overrides'], 'to', e.id)}`,
        members.length ? `  members (${members.length}): ${members.slice(0, 15).map((m) => shortName(m.to_id).split('.').pop()).join(', ')}${members.length > 15 ? ', ...' : ''}` : '',
      );
    }
    return out.filter(Boolean).join('\n');
  },
};

const refs: ToolDef = {
  name: 'refs',
  description: 'References to an entity (reads, writes, invocations, decorators, imports, type uses) with file:line, usage, the referencing entity and a snippet.',
  inputSchema: schema({ symbol: symbolArg, usage: { type: 'string', description: 'Only this usage: read, write, invocation, nameof, typeof, attribute, decorator, import, other.' }, ...paging }, ['symbol']),
  run(ctx) {
    const term = str(ctx.args.symbol)!;
    const usage = str(ctx.args.usage);
    const { found, messages } = resolveEach(ctx, term);
    const items: Item[] = found.flatMap(({ g, e }) =>
      g.reader!.relations(['references'], 'to', e.id, usage).map((x) => ({
        g,
        lines: lines(`${loc(x.path, x.line, ctx.fresh.changed)}  ${x.usage ?? ''}  from ${shortName(x.from_id)}`, quote(g.reader!.snippetAt(x.path, x.line, x.context))),
      })),
    );
    const head = found.map(({ e }) => `references to ${shortName(e.id)}${usage ? ` (usage ${usage})` : ''}`);
    return join([...messages, ...head], found.length ? render(ctx, items, 'references', 'no references') : '');
  },
};

function callGraph(direction: 'callers' | 'callees'): ToolDef {
  return {
    name: direction,
    description: direction === 'callers'
      ? 'Who calls this method or function (declared call targets and template event bindings), with file:line and snippet; depth 1 to 3 follows callers of callers.'
      : 'What this method or function calls (declared call targets, including framework and package APIs), with file:line and snippet; depth 1 to 3 follows further.',
    inputSchema: schema({ symbol: symbolArg, depth: { type: 'integer', minimum: 1, maximum: 3, description: 'Levels to follow (default 1).' }, ...paging }, ['symbol']),
    run(ctx) {
      const term = str(ctx.args.symbol)!;
      const depth = Math.min(Math.max(Number(ctx.args.depth ?? 1) || 1, 1), 3);
      const { found, messages } = resolveEach(ctx, term);
      const items: Item[] = [];
      for (const { g, e } of found) {
        const seen = new Set<string>([e.id]);
        let frontier = [e.id];
        for (let d = 1; d <= depth && frontier.length > 0; d++) {
          const next: string[] = [];
          for (const f of frontier) {
            for (const x of edgesOf(g, f, direction)) {
              const other = direction === 'callers' ? x.from_id : x.to_id;
              const via = d > 1 ? `  (via ${shortName(f)})` : '';
              items.push({ g, lines: lines(`${'  '.repeat(d - 1)}${shortName(other)}  ${loc(x.path, x.line, ctx.fresh.changed)}${via}`, d === 1 ? quote(g.reader!.snippetAt(x.path, x.line, x.context)) : null) });
              if (!seen.has(other)) {
                seen.add(other);
                next.push(other);
              }
            }
          }
          frontier = next;
        }
      }
      const head = found.map(({ e }) => `${direction} of ${shortName(e.id)}${depth > 1 ? `, depth ${depth}` : ''}`);
      return join([...messages, ...head], found.length ? render(ctx, items, direction, `no ${direction}`) : '');
    },
  };
}

const implementations: ToolDef = {
  name: 'implementations',
  description: 'Types and members that implement, inherit from or override this entity, with file:line.',
  inputSchema: schema({ symbol: symbolArg, ...paging }, ['symbol']),
  run(ctx) {
    const term = str(ctx.args.symbol)!;
    const { found, messages } = resolveEach(ctx, term);
    const items: Item[] = found.flatMap(({ g, e }) =>
      g.reader!.relations(['implements', 'inherits', 'overrides'], 'to', e.id).map((x) => ({ g, lines: [`${x.kind}  ${shortName(x.from_id)}  ${loc(x.path, x.line, ctx.fresh.changed)}`] })),
    );
    const head = found.map(({ e }) => `implementations of ${shortName(e.id)}`);
    return join([...messages, ...head], found.length ? render(ctx, items, 'implementations', 'no implementations') : '');
  },
};

const di: ToolDef = {
  name: 'di',
  description: 'Dependency injection: registrations (lifetime or scope, implementation) and consumers (who injects it, how) of a service, with file:line; unresolved consumers say why. Without a service: all registrations.',
  inputSchema: schema({ service: { type: 'string', description: 'Service entity (id, name or qualified tail). Optional.' }, ...paging }),
  run(ctx) {
    const term = str(ctx.args.service);
    const { items, notes } = withIndex(ctx, (g) => {
      const r = g.reader!;
      let ids: Set<string> | null = null;
      if (term) {
        const m = r.resolveSymbol(term);
        ids = 'entity' in m ? new Set([m.entity.id]) : 'candidates' in m ? new Set(m.candidates.map((c) => c.id as string)) : new Set();
      }
      const obs = r.observations(['di.registers', 'di.consumes']).filter((o) => (ids ? ids.has(o.service) : o.kind === 'di.registers'));
      const links = new Map<string, Row>(r.linksFrom(obs.filter((o) => o.kind === 'di.consumes').map((o) => o.id)).map((l) => [l.from_obs, l]));
      return obs.map((o) => {
        const at = loc(o._path, o._line, ctx.fresh.changed);
        if (o.kind === 'di.registers') {
          const impl = o.implementation ?? o.factory ?? o.existing ?? (o.value ? 'value' : null);
          return { g, lines: [`registers ${shortName(o.service)}  ${o.lifetime ?? o.scope ?? ''}  impl ${typeof impl === 'string' ? shortName(impl) : impl ? 'factory' : 'self'}  ${at}`.replace(/\s{3,}/g, '  ')] };
        }
        const l = links.get(o.id);
        const status = l ? (l.resolution === 'unresolved' ? `  unresolved: ${l.reason ?? 'no provider'}` : `  ${l.resolution}`) : '';
        return { g, lines: [`consumes  ${shortName(o.service)} by ${shortName(o.consumer)} via ${o.via ?? '?'}  ${at}${status}`] };
      });
    });
    return join(notes, render(ctx, items, 'DI facts', term ? `no registrations or consumers of '${term}'` : 'no DI registrations'));
  },
};

const routes: ToolDef = {
  name: 'routes',
  description: 'Routes of the application: UI routes (full path, component or lazy target, guards) and HTTP endpoints (method, route template, handler), with file:line.',
  inputSchema: schema({ prefix: { type: 'string', description: 'Only routes starting with this path (parameters may be written as :id or {id}).' }, ...paging }),
  run(ctx) {
    const prefix = str(ctx.args.prefix);
    const want = prefix ? canonicalRoute(prefix).route : null;
    const { items, notes } = withIndex(ctx, (g) => {
      const obs = g.reader!.observations(['ui.route', 'http.endpoint']);
      return obs
        .filter((o) => {
          if (!want) return true;
          const route = o.kind === 'ui.route' ? canonicalRoute(String(o.path ?? '')).route : String(o.canonicalRoute ?? '');
          return route.startsWith(want);
        })
        .map((o) => {
          const at = loc(o._path, o._line, ctx.fresh.changed);
          if (o.kind === 'ui.route') {
            const target = o.component ? shortName(o.component) : o.loadComponent ? `lazy ${shortName(o.loadComponent)}` : o.loadChildren ? `lazy children ${shortName(o.loadChildren)}` : o.redirectTo != null ? `redirect ${o.redirectTo}` : '(no target)';
            const guards = o.guards && Object.keys(o.guards).length ? `  guards ${Object.entries(o.guards).map(([k, v]) => `${k}: ${(Array.isArray(v) ? v : [v]).map((x) => shortName(String(x))).join(', ')}`).join('; ')}` : '';
            return { g, lines: [`UI   ${o.path ?? `(unreached) ${o.ext?.angular?.relativePath ?? ''}`}  -> ${target}${guards}  ${at}`] };
          }
          return { g, lines: [`HTTP ${o.method ?? '*'} ${o.routeTemplate ?? o.canonicalRoute}  -> ${shortName(o.handler)}  ${at}`] };
        });
    });
    return join(notes, render(ctx, items, 'routes', prefix ? `no routes under '${prefix}'` : 'no routes'));
  },
};

function httpLine(o: Row): string {
  const base = o.baseAddress ? `  base ${o.baseAddress.key ?? o.baseAddress.source ?? '?'}${o.baseAddress.nameSource ? ` (${o.baseAddress.nameSource})` : ''}` : '';
  return `${o.method ?? '?'} ${o.canonicalRoute ?? '(unknown route)'}  ${o.resolution ?? ''}${base}  caller ${shortName(o.caller)}`;
}

const http: ToolDef = {
  name: 'http',
  description: 'Outgoing HTTP calls found in code: method, canonical route, resolution, base address source (configuration key, never a secret), the calling method, file:line and snippet.',
  inputSchema: schema({ route: { type: 'string', description: 'Only calls whose canonical route starts with this.' }, method: { type: 'string' }, ...paging }),
  run(ctx) {
    const prefix = str(ctx.args.route);
    const want = prefix ? canonicalRoute(prefix) : null;
    const method = (str(ctx.args.method) ?? want?.method)?.toUpperCase() ?? null;
    const { items, notes } = withIndex(ctx, (g) =>
      g.reader!
        .observations(['http.call'])
        .filter((o) => (!want || String(o.canonicalRoute ?? '').startsWith(want.route)) && (!method || o.method === method))
        .map((o) => ({ g, lines: lines(`${httpLine(o)}  ${loc(o._path, o._line, ctx.fresh.changed)}`, quote(g.reader!.snippetAt(o._path, o._line, o.context))) })),
    );
    return join(notes, render(ctx, items, 'HTTP calls', 'no HTTP calls'));
  },
};

const whoCalls: ToolDef = {
  name: 'who_calls',
  description: 'Who calls an HTTP route: the HTTP calls whose canonical route matches (parameters normalized; a base path prefix gives a suffix match), the methods that make them and their callers (UI components, other services), links to the endpoint that serves the route, and local endpoints for it.',
  inputSchema: schema({ route: { type: 'string', description: 'Route such as `/v1/leases/{id}`, `/v1/leases/:id` or `GET /v1/leases/{}`.' }, method: { type: 'string' }, depth: { type: 'integer', minimum: 0, maximum: 3, description: 'Levels of callers of the calling method (default 1).' }, ...paging }, ['route']),
  run(ctx) {
    const raw = str(ctx.args.route);
    if (!raw) return 'missing route';
    const want = canonicalRoute(raw);
    const method = (str(ctx.args.method) ?? want.method)?.toUpperCase() ?? null;
    const depth = Math.min(Math.max(Number(ctx.args.depth ?? 1), 0), 3);
    const { items, notes } = withIndex(ctx, (g) => {
      const r = g.reader!;
      const out: Item[] = [];
      for (const ep of r.observations(['http.endpoint'])) {
        if (routeMatch(String(ep.canonicalRoute ?? ''), want.route) === 'exact' && (!method || ep.method === method)) {
          out.push({ g, lines: [`served by ${ep.method} ${ep.routeTemplate ?? ep.canonicalRoute} -> ${shortName(ep.handler)}  ${loc(ep._path, ep._line, ctx.fresh.changed)}`] });
        }
      }
      const calls = r.observations(['http.call']).filter((o) => o.canonicalRoute && routeMatch(String(o.canonicalRoute), want.route) && (!method || o.method === method));
      const links = r.linksFrom(calls.map((c) => c.id));
      for (const c of calls) {
        const match = routeMatch(String(c.canonicalRoute), want.route);
        const block = lines(`call ${httpLine(c)}  ${loc(c._path, c._line, ctx.fresh.changed)}${match === 'suffix' ? '  (suffix match)' : ''}`, quote(r.snippetAt(c._path, c._line, c.context)));
        for (const l of links.filter((x) => x.from_obs === c.id)) {
          const to = l.to_obs ? r.observation(l.to_obs) : null;
          block.push(`  link ${l.kind} ${l.resolution}${to ? ` -> ${to.method ?? ''} ${to.canonicalRoute ?? ''} ${shortName(to.handler)} ${loc(to._path, to._line, ctx.fresh.changed)}` : `: ${l.reason ?? 'no target'}`}`);
        }
        if (c.caller && depth > 0) {
          const seen = new Set<string>([c.caller]);
          let frontier: string[] = [c.caller];
          for (let d = 1; d <= depth && frontier.length; d++) {
            const next: string[] = [];
            for (const f of frontier) {
              for (const x of edgesOf(g, f, 'callers')) {
                block.push(`  ${'  '.repeat(d - 1)}called by ${shortName(x.from_id)}  ${loc(x.path, x.line, ctx.fresh.changed)}`);
                if (!seen.has(x.from_id)) {
                  seen.add(x.from_id);
                  next.push(x.from_id);
                }
              }
            }
            frontier = next;
          }
        }
        out.push({ g, lines: block });
      }
      return out;
    });
    const head = `who calls ${method ? method + ' ' : ''}${want.route}`;
    return join([...notes, head], render(ctx, items, 'items', 'no HTTP call or endpoint matches this route in the loaded generation(s); a caller in another repository needs a system generation (federation)'));
  },
};

const PACK_PAGE = 6000;

const context: ToolDef = {
  name: 'context',
  description: 'Context pack cards written by the engine: without `project`, the list of cards (overview, projects, services); with `project` (path, name or card name), that card, paged at 6000 characters.',
  inputSchema: schema({ project: { type: 'string' }, cursor: paging.cursor }),
  run(ctx) {
    const term = str(ctx.args.project);
    const out: string[] = [];
    const multi = ctx.gens.length > 1;
    if (!term) {
      for (const g of ctx.gens) {
        for (const p of listPacks(g.dir, g.manifest)) out.push(`${multi ? `[${g.label}] ` : ''}${p.kind.padEnd(8)} ${p.path}  ${p.title}${p.project ? `  (project ${p.project})` : ''}  ${p.size} bytes`);
      }
      return out.length ? out.join('\n') : 'no context packs in this generation';
    }
    const matches = ctx.gens.flatMap((g) => findPack(listPacks(g.dir, g.manifest), term).map((p) => ({ g, p })));
    if (matches.length === 0) return `no context pack matches '${term}'; call context without project for the list`;
    if (matches.length > 1) {
      const projectCards = matches.filter((m) => m.p.kind === 'project');
      if (projectCards.length !== 1) return [`'${term}' matches ${matches.length} cards; pass one path:`, ...matches.slice(0, 15).map((m) => `  ${multi ? `[${m.g.label}] ` : ''}${m.p.path}  ${m.p.title}`)].join('\n');
      matches.splice(0, matches.length, projectCards[0]);
    }
    const { g, p } = matches[0];
    const text = readPack(g.dir, p);
    const offset = offsetOf(ctx.args.cursor);
    let end = Math.min(offset + PACK_PAGE, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > offset + PACK_PAGE / 2) end = nl + 1;
    }
    const body = text.slice(offset, end);
    const marked = body.replace(/`([^`\s]+):(\d+)`/g, (m, path: string) => (ctx.fresh.changed.has(path) ? `${m} [changed]` : m));
    const footer = end < text.length ? `\n(characters ${offset + 1}-${end} of ${text.length}; more with cursor "${end}")` : '';
    return `${multi ? `[${g.label}] ` : ''}${p.path}\n${marked.trimEnd()}${footer}`;
  },
};

export const TOOLS: ToolDef[] = [generationInfo, search, symbol, refs, callGraph('callers'), callGraph('callees'), implementations, di, routes, http, whoCalls, context];

/** Runs a tool against a resolution: freshness header first, then the tool's answer. */
export function runTool(tool: ToolDef, res: Resolution, args: Record<string, unknown>): { text: string; isError: boolean } {
  const fresh = freshness(res);
  const filter = str(args.generation);
  const gens = filter ? res.loaded.filter((g) => g.label === filter || g.label.startsWith(filter) || g.manifest.engine?.name === filter) : res.loaded;
  if (gens.length === 0) return { text: `${fresh.header}\nno loaded generation matches '${filter}'; loaded: ${res.loaded.map((g) => g.label).join(', ')}`, isError: true };
  return { text: `${fresh.header}\n${tool.run({ res, fresh, gens, args })}`, isError: false };
}

/** Answer when no generation could be loaded: what was tried, so the agent (or user) can act. */
export function noGeneration(res: Resolution, maxAncestors: number): string {
  const ws = res.workspace;
  return [
    `no generation for ${ws.remoteUrl ?? ws.root} at HEAD ${ws.head.slice(0, 12)} or its ${maxAncestors} nearest first-parent ancestors`,
    'sources tried:',
    ...res.sources.map((s) => `  ${s}`),
    ...(res.skipped.length ? ['skipped:', ...res.skipped.map((s) => `  ${s}`)] : []),
    ...(res.errors.length ? ['errors:', ...res.errors.map((s) => `  ${s}`)] : []),
  ].join('\n');
}
