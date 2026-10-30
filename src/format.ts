// Bounded answers (PLAN M8): pagination, compact entity names, locations marked when changed since the generation,
// canonical routes for matching.

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface Paged<T> {
  items: T[];
  total: number;
  offset: number;
  next: string | null;
}

export function limitOf(v: unknown): number {
  const n = Number(v ?? DEFAULT_LIMIT);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_LIMIT) : DEFAULT_LIMIT;
}

/** The cursor is an opaque string for clients; today it is the decimal offset. */
export function offsetOf(cursor: unknown): number {
  const n = Number(cursor ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function page<T>(all: T[], limit: number, offset: number): Paged<T> {
  const items = all.slice(offset, offset + limit);
  return { items, total: all.length, offset, next: offset + items.length < all.length ? String(offset + items.length) : null };
}

export function pageFooter(p: { total: number; offset: number; items: unknown[]; next: string | null }, noun: string): string {
  if (p.total === 0) return '';
  const range = `${p.offset + 1}-${p.offset + p.items.length} of ${p.total} ${noun}`;
  return p.next ? `${range}; more with cursor "${p.next}"` : range;
}

/**
 * Short, still resolvable name of an entity id:
 * `ts:.:src/app/x/leases.service#LeasesService.search` → `LeasesService.search`;
 * `dotnet:src/A/A.csproj:M:Ns.Sub.Type.Method(System.Guid)` → `Type.Method(Guid)`;
 * a module (empty symbol path) gives `module src/app/x/leases.service`;
 * package symbols keep the package: `@angular/common HttpClient.post(...)`.
 */
export function shortName(id: string | null | undefined): string {
  if (!id) return '(none)';
  const ts = /^ts:(?:pkg:(.+?)@[^:]+:|[^:]*:)([^#]*)#(.*)$/.exec(id);
  if (ts) {
    const name = ts[3] || `module ${ts[2]}`;
    return ts[1] ? `${ts[1]} ${name}` : name;
  }
  const dn = /^dotnet:(pkg:([^@]+)@[^:]+:[^:]+:|[^:]+:)?([A-Z]):(.*)$/.exec(id);
  if (dn) {
    const doc = dn[4];
    const paren = doc.indexOf('(');
    const head = paren >= 0 ? doc.slice(0, paren) : doc;
    const args = paren >= 0 ? doc.slice(paren).replace(/[\w.]+\.(\w+)/g, '$1') : '';
    const parts = head.split('.');
    const keep = dn[3] === 'T' || dn[3] === 'N' ? parts.slice(-1) : parts.slice(-2);
    const name = keep.join('.').replace(/^#ctor$/, 'ctor') + args;
    return dn[2] ? `${dn[2]} ${name}` : name;
  }
  return id;
}

export function loc(path: string | null | undefined, line: number | bigint | null | undefined, changed: Set<string>): string {
  if (!path) return '(no location)';
  return `${path}${line != null ? `:${Number(line)}` : ''}${changed.has(path) ? ' [changed]' : ''}`;
}

/**
 * Canonical route as the contract defines it: one leading `/`, lower-case literals, parameters `{}` (optional `{?}`,
 * catch-all `{**}`), no query, no trailing `/`. Accepts `:name`, `{name}`, `{name:constraint}`, a method prefix and a
 * scheme and host, which are removed. Returns the method separately when one was given.
 */
export function canonicalRoute(input: string): { method: string | null; route: string } {
  let s = input.trim();
  let method: string | null = null;
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i.exec(s);
  if (m) {
    method = m[1].toUpperCase();
    s = s.slice(m[0].length);
  }
  // The query starts at a `?` that is not the optional marker inside `{name?}`.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').replace(/#.*$/, '').replace(/\?[^}]*$/, '');
  const segs = s.split('/').filter(Boolean).map((seg) => {
    if (/^\{\*{1,2}[^}]*\}$/.test(seg)) return '{**}';
    if (/^\{[^}]*\?\}$/.test(seg) || /^:\w+\?$/.test(seg)) return '{?}';
    if (/^\{[^}]*\}$/.test(seg) || /^:\w+$/.test(seg) || /^\$\{[^}]*\}$/.test(seg)) return '{}';
    return seg.toLowerCase();
  });
  return { method, route: '/' + segs.join('/') };
}

/** `exact` when equal; `suffix` when one route ends with the other (both start with `/`, so at a segment boundary): a gateway or base path prefix. */
export function routeMatch(callRoute: string, target: string): 'exact' | 'suffix' | null {
  if (callRoute === target) return 'exact';
  if (target !== '/' && callRoute.endsWith(target)) return 'suffix';
  if (callRoute !== '/' && target.endsWith(callRoute)) return 'suffix';
  return null;
}
