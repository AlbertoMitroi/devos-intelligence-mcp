// The MCP tools (PLAN, Tools). Every answer starts with the freshness header, lists `file:line` evidence with one-line
// redacted snippets, and is bounded by `limit` and `cursor`. Several loaded generations are queried together and each
// item is tagged with its generation label.
import { canonicalRoute, inputOf, limitOf, loc, offsetOf, page, pageFooter, routeMatch, shortName } from '../format.ts';
import { snippet } from '../redact.ts';
import { findPack, listPacks, readPack } from '../generation/context-packs.ts';
import { Tracer } from '../generation/trace.ts';
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
const scopeArg = { scope: { type: 'string', enum: ['repo', 'system'], description: 'In a system generation: `repo` (default) only this repository\'s input, `system` every input.' } };

/** In a system generation, list tools keep this repository's input unless `scope: system`. */
function inScope(ctx: ToolContext, g: Loaded, recordId: string | null | undefined): boolean {
  if (!g.system || ctx.args.scope === 'system') return true;
  return g.system.mine.includes(inputOf(recordId) ?? '');
}

const symbolArg = { type: 'string', description: 'Entity id, exact name, or qualified tail such as `LeasesService.search`.' };

function schema(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: { ...props, ...common }, required, additionalProperties: false };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * A location in an answer. In a system generation every record id starts with its input (`leasing/ev:...`), and the
 * location says which repository it is in: `[leasing] src/...:36`. Only this repository's files can be [changed].
 */
function at(ctx: ToolContext, path: string | null | undefined, line: number | bigint | null | undefined, recordId: string | null | undefined): string {
  const input = inputOf(recordId);
  const changed = !input || ctx.fresh.inputs.includes(input) ? ctx.fresh.changed : EMPTY;
  return `${input ? `[${input}] ` : ''}${loc(path, line, changed)}`;
}
const EMPTY = new Set<string>();

interface Item {
  g: Loaded;
  lines: string[];
}

/** Items of all generations, paged together; the label prefixes each item only when several generations are loaded. */
function render(ctx: ToolContext, items: Item[], noun: string, empty: string): string {
  const p = page(items, limitOf(ctx.args.limit), offsetOf(ctx.args.cursor));
  if (p.total === 0) {
    const partial = ctx.gens.filter((g) => g.manifest.status && g.manifest.status !== 'complete');
    return partial.length ? `${empty}\nnote: ${partial.map((g) => g.label).join(', ')} is ${partial[0].manifest.status}; an absence of results is not proof of absence` : empty;
  }
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
    const m = g.reader.resolveSymbol(term, g.system?.mine ?? []);
    if ('entity' in m) found.push({ g, e: m.entity });
    else if ('candidates' in m) {
      const decl = (id: string) => g.reader!.firstDeclaration(id);
      messages.push(`${tag}'${term}' is ambiguous (${m.total}${m.total > 10 ? '+' : ''} candidates); pass one id:`);
      for (const c of m.candidates) {
        const d = decl(c.id);
        messages.push(`  ${c.kind} ${c.id}${d ? `  ${at(ctx, d.path, d.line, c.id)}` : ''}`);
      }
    } else messages.push(`${tag}${m.none}`);
  }
  // A symbol found in one generation is enough; "not found" from the others is noise then.
  return { found, messages: found.length > 0 ? messages.filter((x) => !/no entity named/.test(x)) : messages };
}

function edgesOf(g: Loaded, id: string, direction: 'callers' | 'callees'): Row[] {
  const r = g.reader!;
  const dir = direction === 'callers' ? 'to' : 'from';
  // possible_runtime_target: interface or virtual dispatch to a known implementation (.NET); always a candidate.
  const rows = [...r.relations(['calls_declared_target'], dir, id), ...r.relations(['references'], dir, id, 'invocation'), ...r.relations(['possible_runtime_target'], dir, id)];
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
      const counts = g.reader ? `schema ${g.reader.meta().indexSchema ?? '(unversioned)'}, ${Object.entries(g.reader.counts()).map(([k, v]) => `${k} ${v}`).join(', ')}` : g.readerError;
      const packs = listPacks(g.dir, m);
      const meta = g.reader?.meta() ?? {};
      const inputs = g.reader?.tables.has('inputs') ? g.reader.all('select id from inputs order by id').map((r) => r.id as string) : [];
      out.push(
        '',
        `generation ${g.label}${meta.generationType === 'system' ? ` (system generation ${meta.system ?? ''}, ${inputs.length} inputs: ${inputs.join(', ')})` : ''}`,
        `  source ${g.source}: ${g.origin}`,
        `  engine ${m.engine?.name ?? '?'} ${m.engine?.version ?? ''}, contract ${m.schemaVersion}, status ${m.status ?? '?'}, commit ${m.commit}`,
        `  verified: manifest SHA-256 ${g.manifestSha256.slice(0, 16)}..., ${m.files?.length ?? 0} listed files checked${g.notes.length ? `; notes: ${g.notes.join('; ')}` : ''}`,
        ...(g.system ? [`  system ${g.system.name}, this repository is input ${g.system.mine.join(' and ')} at ${g.system.commit.slice(0, 12)}${g.system.secondary ? ` (secondary: ${g.system.distance} commit(s) behind; cross-repository tools only)` : ''}`, ...g.system.inputs.map((i) => `    input ${i.id}${i.included ? '' : ' (not included)'}: ${i.remoteUrl ?? '(no remote)'} at ${i.commit.slice(0, 12)}, ${i.engine ?? '?'}`)] : []),
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
  inputSchema: schema({ query: { type: 'string', description: 'Words to match (prefix match from 3 characters).' }, kind: { type: 'string', enum: ['entity', 'snippet', 'observation'], description: 'observation: endpoints, calls, config keys, messages (when the engine indexes them).' }, ...scopeArg, ...paging }, ['query']),
  run(ctx) {
    const q = str(ctx.args.query);
    if (!q) return 'missing query';
    const kind = str(ctx.args.kind);
    const want = offsetOf(ctx.args.cursor) + limitOf(ctx.args.limit);
    let total = 0;
    const { items, notes } = withIndex(ctx, (g) => {
      const r = g.reader!;
      // In a system generation the scope filter runs after the search, so the total counts every input.
      const { rows: found, total: t } = r.search(q, kind, g.system ? 1000 : want, 0);
      const rows = found.filter((x) => inScope(ctx, g, x.ref));
      total += g.system ? rows.length : t;
      return rows.map((x) => {
        if (x.kind === 'entity') {
          const e = r.entity(x.ref);
          const d = r.firstDeclaration(x.ref);
          return { g, lines: lines(`entity ${e?.kind ?? ''} ${shortName(x.ref)}  ${d ? at(ctx, d.path, d.line, x.ref) : '(no declaration: package symbol)'}`, `    id ${x.ref}`) };
        }
        if (x.kind === 'observation') {
          const o = r.observation(x.ref);
          return { g, lines: lines(`observation ${o?.kind ?? ''} ${o ? at(ctx, o._path, o._line, o.id) : x.ref}`, quote(x.text)) };
        }
        const ev = r.snippetLocation(x.ref, x.text);
        return { g, lines: lines(`snippet ${ev ? at(ctx, ev.path, ev.line, x.ref) : x.ref}`, quote(x.text)) };
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
        ...decls.slice(0, 5).map((d) => `  declared at ${at(ctx, d.path, d.line, e.id)}`),
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
      g.reader!.references(e.id, usage).map((x) => ({
        g,
        lines: lines(`${at(ctx, x.path, x.line, x.id)}  ${x.usage ?? ''}  from ${shortName(x.from_id)}`, quote(x.text ?? g.reader!.snippetAt(x.path, x.line, x.context))),
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
              const pkg = g.reader!.packageImplementation(other);
              const implemented = pkg ? `\n${'  '.repeat(d)}  implemented by ${shortName(pkg.source)}  ${at(ctx, g.reader!.firstDeclaration(pkg.source)?.path, g.reader!.firstDeclaration(pkg.source)?.line, pkg.source)}  (consumed ${pkg.consumed}, produced ${pkg.produced ?? '?'}: versionMatch ${pkg.versionMatch ?? 'unknown'})` : '';
              items.push({ g, lines: lines(`${'  '.repeat(d - 1)}${shortName(other)}  ${at(ctx, x.path, x.line, x.id)}${via}${x.kind === 'possible_runtime_target' ? '  (possible runtime target)' : ''}${implemented}`, d === 1 ? quote(g.reader!.snippetAt(x.path, x.line, x.context)) : null) });
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
      g.reader!.relations(['implements', 'inherits', 'overrides'], 'to', e.id).map((x) => ({ g, lines: [`${x.kind}  ${shortName(x.from_id)}  ${at(ctx, x.path, x.line, x.id)}`] })),
    );
    const head = found.map(({ e }) => `implementations of ${shortName(e.id)}`);
    return join([...messages, ...head], found.length ? render(ctx, items, 'implementations', 'no implementations') : '');
  },
};

const di: ToolDef = {
  name: 'di',
  description: 'Dependency injection: registrations (lifetime or scope, implementation) and consumers (who injects it, how) of a service, with file:line; unresolved consumers say why. Without a service: all registrations.',
  inputSchema: schema({ service: { type: 'string', description: 'Service entity (id, name or qualified tail). Optional.' }, ...scopeArg, ...paging }),
  run(ctx) {
    const term = str(ctx.args.service);
    const { items, notes } = withIndex(ctx, (g) => {
      const r = g.reader!;
      let ids: Set<string> | null = null;
      if (term) {
        const m = r.resolveSymbol(term, g.system?.mine ?? []);
        ids = 'entity' in m ? new Set([m.entity.id]) : 'candidates' in m ? new Set(m.candidates.map((c) => c.id as string)) : new Set();
      }
      const obs = r.observations(['di.registers', 'di.consumes']).filter((o) => (ids ? ids.has(o.service) : o.kind === 'di.registers') && inScope(ctx, g, o.id));
      const links = new Map<string, Row>(r.linksFrom(obs.filter((o) => o.kind === 'di.consumes').map((o) => o.id)).map((l) => [l.from_obs, l]));
      return obs.map((o) => {
        const where = at(ctx, o._path, o._line, o.id);
        if (o.kind === 'di.registers') {
          const impl = o.implementation ?? o.factory ?? o.existing ?? (o.value ? 'value' : null);
          return { g, lines: [`registers ${shortName(o.service)}  ${o.lifetime ?? o.scope ?? ''}  impl ${typeof impl === 'string' ? shortName(impl) : impl ? 'factory' : 'self'}  ${where}`.replace(/\s{3,}/g, '  ')] };
        }
        const l = links.get(o.id);
        const status = l ? (l.resolution === 'unresolved' ? `  unresolved: ${l.reason ?? 'no provider'}` : `  ${l.resolution}`) : '';
        return { g, lines: [`consumes  ${shortName(o.service)} by ${shortName(o.consumer)} via ${o.via ?? '?'}  ${where}${status}`] };
      });
    });
    return join(notes, render(ctx, items, 'DI facts', term ? `no registrations or consumers of '${term}'` : 'no DI registrations'));
  },
};

const routes: ToolDef = {
  name: 'routes',
  description: 'Routes of the application: UI routes (full path, component or lazy target, guards) and HTTP endpoints (method, route template, handler), with file:line.',
  inputSchema: schema({ prefix: { type: 'string', description: 'Only routes starting with this path (parameters may be written as :id or {id}).' }, ...scopeArg, ...paging }),
  run(ctx) {
    const prefix = str(ctx.args.prefix);
    const want = prefix ? canonicalRoute(prefix).route : null;
    const { items, notes } = withIndex(ctx, (g) => {
      const obs = g.reader!.observations(['ui.route', 'http.endpoint']);
      return obs
        .filter((o) => inScope(ctx, g, o.id))
        .filter((o) => {
          if (!want) return true;
          const route = o.kind === 'ui.route' ? canonicalRoute(String(o.path ?? '')).route : String(o.canonicalRoute ?? '');
          return route.startsWith(want);
        })
        .map((o) => {
          const where = at(ctx, o._path, o._line, o.id);
          if (o.kind === 'ui.route') {
            const target = o.component ? shortName(o.component) : o.loadComponent ? `lazy ${shortName(o.loadComponent)}` : o.loadChildren ? `lazy children ${shortName(o.loadChildren)}` : o.redirectTo != null ? `redirect ${o.redirectTo}` : '(no target)';
            const guards = o.guards && Object.keys(o.guards).length ? `  guards ${Object.entries(o.guards).map(([k, v]) => `${k}: ${(Array.isArray(v) ? v : [v]).map((x) => shortName(String(x))).join(', ')}`).join('; ')}` : '';
            return { g, lines: [`UI   ${o.path ?? `(unreached) ${o.ext?.angular?.relativePath ?? ''}`}  -> ${target}${guards}  ${where}`] };
          }
          return { g, lines: [`HTTP ${o.method ?? '*'} ${o.routeTemplate ?? o.canonicalRoute}  -> ${shortName(o.handler)}  ${where}`] };
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
  inputSchema: schema({ route: { type: 'string', description: 'Only calls whose canonical route starts with this.' }, method: { type: 'string' }, ...scopeArg, ...paging }),
  run(ctx) {
    const prefix = str(ctx.args.route);
    const want = prefix ? canonicalRoute(prefix) : null;
    const method = (str(ctx.args.method) ?? want?.method)?.toUpperCase() ?? null;
    const { items, notes } = withIndex(ctx, (g) =>
      g.reader!
        .observations(['http.call'])
        .filter((o) => inScope(ctx, g, o.id) && (!want || String(o.canonicalRoute ?? '').startsWith(want.route)) && (!method || o.method === method))
        .map((o) => ({ g, lines: lines(`${httpLine(o)}  ${at(ctx, o._path, o._line, o.id)}`, quote(g.reader!.snippetAt(o._path, o._line, o.context))) })),
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
      const calls = r.observations(['http.call']).filter((o) => o.canonicalRoute && routeMatch(String(o.canonicalRoute), want.route) && (!method || o.method === method));
      const matched = new Set(calls.map((c) => c.id));
      for (const ep of r.observations(['http.endpoint'])) {
        if (routeMatch(String(ep.canonicalRoute ?? ''), want.route) === 'exact' && (!method || ep.method === method)) {
          const block = [`served by ${ep.method} ${ep.routeTemplate ?? ep.canonicalRoute} -> ${shortName(ep.handler)}  ${at(ctx, ep._path, ep._line, ep.id)}`];
          // Callers the engine or a federation linked to this endpoint (the `calls-to` verb), whatever their route text.
          // Calls matched by route are listed below with their callers; here only the ones linked under another route text.
          for (const l of r.linksTo([ep.id])) {
            const from = r.observation(l.from_obs);
            if (!from || matched.has(from.id)) continue;
            block.push(`  linked caller ${l.kind} ${l.resolution}: ${from.kind} ${from.method ?? ''} ${from.canonicalRoute ?? ''} caller ${shortName(from.caller ?? from.sender)}  ${at(ctx, from._path, from._line, from.id)}`.replace(/\s{2,}(?=caller)/, ' '));
          }
          out.push({ g, lines: block });
        }
      }
      const links = r.linksFrom(calls.map((c) => c.id));
      for (const c of calls) {
        const match = routeMatch(String(c.canonicalRoute), want.route);
        const block = lines(`call ${httpLine(c)}  ${at(ctx, c._path, c._line, c.id)}${match === 'suffix' ? '  (suffix match)' : ''}`, quote(r.snippetAt(c._path, c._line, c.context)));
        for (const l of links.filter((x) => x.from_obs === c.id)) {
          const to = l.to_obs ? r.observation(l.to_obs) : null;
          block.push(`  link ${l.kind} ${l.resolution}${to ? ` -> ${to.method ?? ''} ${to.canonicalRoute ?? ''} ${shortName(to.handler)} ${at(ctx, to._path, to._line, to.id)}` : `: ${l.reason ?? 'no target'}`}`);
        }
        if (c.caller && depth > 0) {
          const seen = new Set<string>([c.caller]);
          let frontier: string[] = [c.caller];
          for (let d = 1; d <= depth && frontier.length; d++) {
            const next: string[] = [];
            for (const f of frontier) {
              for (const x of edgesOf(g, f, 'callers')) {
                block.push(`  ${'  '.repeat(d - 1)}called by ${shortName(x.from_id)}  ${at(ctx, x.path, x.line, x.id)}`);
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
    return join([...notes, head], render(ctx, items, 'items', ctx.gens.some((g) => g.system) ? 'no HTTP call or endpoint matches this route in the system generation' : 'no HTTP call or endpoint matches this route in the loaded generation(s); a caller in another repository needs a system generation (federation)'));
  },
};

/** A message contract is an entity id (v1.1 engines) or `{entity, fullName, name, identity}` (.NET). */
function contractName(c: unknown): string {
  if (c && typeof c === 'object') {
    const o = c as Row;
    return o.fullName ?? o.name ?? shortName(o.entity ?? o.identity);
  }
  return shortName(typeof c === 'string' ? c : null);
}

const messages: ToolDef = {
  name: 'messages',
  description: 'Messaging and real time: publishers and subscribers (contract, transport, destination), SignalR pushes and client subscriptions (method), with file:line and the links between them (across repositories in a system generation); filter by contract, destination or method name.',
  inputSchema: schema({ contract: { type: 'string', description: 'Only messages whose contract or destination contains this text.' }, ...paging }),
  run(ctx) {
    const term = str(ctx.args.contract)?.toLowerCase() ?? null;
    const { items, notes } = withIndex(ctx, (g) => {
      const r = g.reader!;
      // Call-site arguments that name a destination (contract v1.2, C7): `SendToAll("flowUpdated", ...)` in a consumer.
      const all = [...r.observations(['messaging.publish', 'messaging.subscribe', 'realtime.send', 'realtime.subscribe']), ...r.observations(['call.argument']).filter((o) => o.role?.kind === 'realtime.send' || o.role?.kind?.startsWith('messaging.'))];
      const matches = (o: Row) => [contractName(o.contract), o.contract?.fullName, o.messageType, o.destination?.name, o.topic, o.queue, o.method, o.route, o.value].some((v) => typeof v === 'string' && v.toLowerCase().includes(term!));
      const direct = new Set(all.filter((o) => !term || matches(o)).map((o) => o.id));
      // A send whose name comes from a call-site argument matches through the subscription it is linked to.
      const linksAll = r.linksFrom(all.map((o) => o.id));
      for (const l of linksAll) if (term && l.to_obs && direct.has(l.to_obs)) direct.add(l.from_obs);
      const obs = all.filter((o) => direct.has(o.id));
      const links = linksAll.filter((l) => direct.has(l.from_obs));
      return obs.map((o) => {
        if (o.kind === 'call.argument') {
          return { g, lines: [`argument ${JSON.stringify(o.value ?? null)} for ${o.role?.kind ?? '?'} ${o.role?.field ?? o.parameter}  in call to ${shortName(o.callee)}  by ${shortName(o.caller)}  ${at(ctx, o._path, o._line, o.id)}`] };
        }
        if (o.kind.startsWith('realtime.')) {
          const who = o.kind === 'realtime.send' ? o.sender : o.subscriber ?? o.handler ?? o.consumer ?? o.client;
          const name = o.method ?? (o.destinationParameter ? `(method from call-site argument '${o.destinationParameter.parameter}')` : '?');
          const block = [`${o.kind === 'realtime.send' ? 'push     ' : 'listen   '} ${name}  realtime ${o.route ?? (typeof o.hub === 'string' ? shortName(o.hub) : '')}${o.audience ? `  audience ${o.audience}` : ''}  by ${shortName(who)}  ${at(ctx, o._path, o._line, o.id)}`.replace(/\s{3,}/g, '  ')];
          for (const l of links.filter((x) => x.from_obs === o.id)) {
            const to = l.to_obs ? r.observation(l.to_obs) : null;
            block.push(`  link ${l.kind} ${l.resolution}${to ? ` -> ${to.kind} ${to.method ?? ''} by ${shortName(to.subscriber ?? to.handler ?? to.client ?? to.caller)} ${at(ctx, to._path, to._line, to.id)}` : ''}${l.reason ? `: ${l.reason}` : ''}`);
          }
          return { g, lines: block };
        }
        const dest = o.destination ? `${o.destination.kind ?? 'destination'} ${o.destination.name ?? '?'}${o.destination.nameSource ? ` (${o.destination.nameSource})` : ''}` : 'destination unknown';
        const who = o.kind === 'messaging.publish' ? o.publisher ?? o.sender : o.handler ?? o.consumer ?? o.subscriber;
        const block = [`${o.kind === 'messaging.publish' ? 'publish  ' : 'subscribe'} ${contractName(o.contract ?? o.messageType)}  ${o.transport ?? (o.transports ? o.transports.join('|') : '')}  ${dest}  by ${shortName(who)}  ${at(ctx, o._path, o._line, o.id)}`.replace(/\s{3,}/g, '  ')];
        for (const l of links.filter((x) => x.from_obs === o.id)) {
          const to = l.to_obs ? r.observation(l.to_obs) : null;
          block.push(`  link ${l.kind} ${l.resolution}${to ? ` -> ${to.kind} by ${shortName(to.handler ?? to.consumer ?? to.subscriber)} ${at(ctx, to._path, to._line, to.id)}` : `: ${l.reason ?? 'no target'}`}`);
        }
        return { g, lines: block };
      });
    });
    return join(notes, render(ctx, items, 'messaging facts', term ? `no publisher or subscriber matches '${term}'` : 'no messaging observed'));
  },
};

/** One line naming a trace node: an entity by short name, an observation by kind and its main field. */
function nodeName(g: Loaded, node: string): string {
  if (!node.startsWith('obs:') && !node.includes('/obs:')) return shortName(node);
  const o = g.reader!.observation(node);
  if (!o) return node;
  const what = o.canonicalRoute ? `${o.method ?? ''} ${o.canonicalRoute}`.trim()
    : o.contract ? contractName(o.contract)
    : o.request ? shortName(o.request)
    : o.service && typeof o.service === 'string' ? shortName(o.service)
    : o.method ?? (o.destinationParameter ? `(method from call-site argument '${o.destinationParameter.parameter}')` : null) ?? o.route ?? o.key ?? o.name ?? '';
  return `${o.kind} ${what}`.trim();
}

const trace: ToolDef = {
  name: 'trace',
  description: 'Path across code and services from a symbol (or observation id): calls, observations made in a method (HTTP calls, sends, publishes), links between observations (dispatch, messaging, routes) and the handlers that serve them. With `to` (symbol, observation id or project), the shortest path; without, every reachable service-side observation (endpoints, handlers, subscribers). Each path names its weakest link.',
  inputSchema: schema({ from: symbolArg, to: { type: 'string', description: 'Target symbol, observation id or project path. Optional.' }, depth: { type: 'integer', minimum: 1, maximum: 12, description: 'Maximum steps (default 8).' }, ...paging }, ['from']),
  run(ctx) {
    const from = str(ctx.args.from);
    if (!from) return 'missing from';
    const to = str(ctx.args.to);
    const depth = Math.min(Math.max(Number(ctx.args.depth ?? 8) || 8, 1), 12);
    const messages: string[] = [];
    const multi = ctx.gens.length > 1;
    const items: Item[] = [];
    for (const g of ctx.gens) {
      const tag = multi ? `[${g.label}] ` : '';
      if (!g.reader) {
        messages.push(`${tag}${g.readerError}`);
        continue;
      }
      const tracer = new Tracer(g.reader);
      const resolveEntity = (t: string): string | null => {
        const m = g.reader!.resolveSymbol(t, g.system?.mine ?? []);
        if ('entity' in m) return m.entity.id;
        messages.push(`${tag}${'candidates' in m ? `'${t}' is ambiguous; pass one of: ${m.candidates.slice(0, 5).map((c) => c.id).join(', ')}` : m.none}`);
        return null;
      };
      const start = tracer.isObservation(from) ? (g.reader.observation(from) ? from : (messages.push(`${tag}no observation ${from}`), null)) : resolveEntity(from);
      if (!start) continue;
      let target: ((n: string) => boolean) | null = null;
      if (to) {
        const t = tracer.targetOf(to, resolveEntity);
        if (typeof t === 'string') {
          if (!messages.some((m) => m.includes(to))) messages.push(`${tag}${t}`);
          continue;
        }
        target = t;
      }
      for (const p of tracer.trace(start, target, depth)) {
        const lines = [`${nodeName(g, p.to)}  (${p.steps.length} step(s), weakest link: step ${p.weakest.step}, ${p.weakest.resolution})`];
        p.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.kind} ${s.resolution}  ${nodeName(g, s.to)}  ${at(ctx, s.path, s.line, s.via)}`));
        items.push({ g, lines });
      }
      messages.push(`${tag}trace from ${nodeName(g, start)}${to ? ` to ${to}` : ' to service-side observations'}, depth ${depth}`);
    }
    // A symbol found in one generation is enough; "not found" from the others is noise then.
    const shown = items.length ? messages.filter((m) => !/no entity|no observation/.test(m)) : messages;
    return join(shown, render(ctx, items, 'paths', to ? `no path within ${depth} steps` : `no service-side observation reachable within ${depth} steps`));
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

export const TOOLS: ToolDef[] = [generationInfo, search, symbol, refs, callGraph('callers'), callGraph('callees'), implementations, di, routes, http, whoCalls, messages, trace, context];

/** Runs a tool against a resolution: freshness header first, then the tool's answer. */
const CROSS_REPOSITORY = new Set(['who_calls', 'trace', 'messages']);

export function runTool(tool: ToolDef, res: Resolution, args: Record<string, unknown>): { text: string; isError: boolean } {
  const fresh = freshness(res);
  const filter = str(args.generation);
  // Cross-repository tools answer from a system generation when one is loaded; the others from the generations that
  // answer for this repository (a secondary system only when asked for by name).
  const systems = res.loaded.filter((g) => g.system);
  const gens = filter
    ? res.loaded.filter((g) => g.label === filter || g.label.startsWith(filter) || g.manifest.engine?.name === filter)
    : CROSS_REPOSITORY.has(tool.name) && systems.length ? systems : res.loaded.filter((g) => !g.system?.secondary);
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
