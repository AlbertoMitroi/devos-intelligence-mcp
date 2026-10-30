// Engine-neutral reader of `index.sqlite` (PLAN M7). Uses only the tables both engines write (the Angular engine's
// `src/artifacts/sqlite.ts`, mirrored by the .NET engine in Step 4) and the contract kinds; observation details come
// from the canonical JSON column, so engine extensions are carried, never required. The .NET additions agreed for the
// shared schema (`relation_evidence`, `observation_evidence`, `link_evidence`, `evidence_snippet`, meta `indexSchema`,
// search kind `observation`) are used when present and never required.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

export type Row = Record<string, any>;

const REQUIRED_TABLES = ['meta', 'entities', 'declarations', 'evidence', 'relations', 'observations', 'links'];

export type SymbolMatch = { entity: Row } | { candidates: Row[]; total: number } | { none: string };

export class IndexReader {
  db: DatabaseSync;
  tables: Set<string>;
  hasSearch: boolean;
  cache = new Map<string, unknown>();

  constructor(db: DatabaseSync, tables: Set<string>) {
    this.db = db;
    this.tables = tables;
    this.hasSearch = tables.has('search');
  }

  static open(path: string): { reader: IndexReader | null; error: string | null } {
    if (!existsSync(path)) return { reader: null, error: 'this generation has no index.sqlite (the engine does not write one yet); generation_info and context still work' };
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      const tables = new Set((db.prepare("select name from sqlite_master where type in ('table', 'view')").all() as Row[]).map((r) => r.name as string));
      const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
      if (missing.length) {
        db.close();
        return { reader: null, error: `index.sqlite lacks table(s) ${missing.join(', ')}; schema not recognized` };
      }
      return { reader: new IndexReader(db, tables), error: null };
    } catch (e) {
      return { reader: null, error: `index.sqlite cannot be opened: ${(e as Error).message}` };
    }
  }

  all(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  one(sql: string, ...params: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  meta(): Record<string, string> {
    return Object.fromEntries(this.all('select key, value from meta').map((r) => [r.key, r.value]));
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of ['entities', 'relations', 'observations', 'links', 'evidence']) out[t] = Number(this.one(`select count(*) as n from ${t}`)!.n);
    return out;
  }

  /**
   * A symbol is an entity id, an exact name, or a qualified tail (`LeasesService.search`, `Controllers.LeasesController`).
   * Source entities are preferred over package or metadata ones when a name matches both.
   */
  resolveSymbol(term: string): SymbolMatch {
    const t = term.trim();
    if (!t) return { none: 'empty symbol' };
    const byId = this.one('select * from entities where id = ?', t);
    if (byId) return { entity: byId };
    const last = t.split(/[.#:/]/).filter(Boolean).pop() ?? t;
    const bare = last.replace(/\(.*$/, '');
    let rows = this.all("select * from entities where name = ? order by case origin when 'source' then 0 else 1 end, id", bare);
    if (t !== bare) {
      const q = t.replace(/\(.*$/, '');
      rows = rows.filter((r) => {
        const id = String(r.id).replace(/\(.*$/, '');
        return id.endsWith(`#${q}`) || id.endsWith(`.${q}`) || id.endsWith(`:${q}`) || id.endsWith(`/${q}`) || id === q;
      });
    }
    if (rows.length === 0) {
      const like = this.all("select * from entities where id like ? escape '\\' order by case origin when 'source' then 0 else 1 end, length(id), id limit 11", `%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
      if (like.length === 1) return { entity: like[0] };
      if (like.length === 0) return { none: `no entity named '${t}' (try search)` };
      return { candidates: like.slice(0, 10), total: like.length };
    }
    const source = rows.filter((r) => r.origin === 'source');
    const pool = source.length > 0 ? source : rows;
    if (pool.length === 1) return { entity: pool[0] };
    return { candidates: pool.slice(0, 10), total: pool.length };
  }

  declarations(id: string): Row[] {
    return this.all('select path, line from declarations where entity = ? order by path, line', id);
  }

  firstDeclaration(id: string): Row | undefined {
    return this.one('select path, line from declarations where entity = ? order by path, line limit 1', id);
  }

  /** Snippet text of the evidence at `path:line` in the given analysis context (any context when null). */
  snippetAt(path: string | null, line: number | null, context: string | null = null): string | null {
    if (!path || line == null) return null;
    const r = context
      ? this.one('select text from evidence where path = ? and line = ? and context = ? and text is not null limit 1', path, line, context)
      : this.one('select text from evidence where path = ? and line = ? and text is not null limit 1', path, line);
    return (r?.text as string) ?? null;
  }

  search(text: string, kind: string | null, limit: number, offset: number): { rows: Row[]; total: number } {
    const tokens = text.split(/\s+/).map((t) => t.replace(/"/g, '')).filter(Boolean);
    if (tokens.length === 0) return { rows: [], total: 0 };
    if (this.hasSearch) {
      const match = tokens.map((t) => `"${t}"${t.length >= 3 ? '*' : ''}`).join(' ');
      const where = `search match ?${kind ? ' and kind = ?' : ''}`;
      const params: string[] = kind ? [match, kind] : [match];
      try {
        const total = Number(this.one(`select count(*) as n from search where ${where}`, ...params)!.n);
        const rows = this.all(`select ref, kind, text from search where ${where} order by rank, ref limit ? offset ?`, ...params, limit, offset);
        return { rows, total };
      } catch {
        /* FTS syntax the tokenizer refuses: fall through to the name lookup */
      }
    }
    if (kind === 'snippet') return { rows: [], total: 0 };
    const like = `%${tokens.join('%')}%`;
    const total = Number(this.one('select count(*) as n from entities where name like ? or signature like ?', like, like)!.n);
    const rows = this.all("select id as ref, 'entity' as kind, name || ' ' || signature as text from entities where name like ? or signature like ? order by name, id limit ? offset ?", like, like, limit, offset);
    return { rows, total };
  }

  entity(id: string): Row | undefined {
    return this.one('select * from entities where id = ?', id);
  }

  /** Relations of `kinds` arriving at (`to`) or leaving (`from`) the entity, with their first evidence location. */
  relations(kinds: string[], direction: 'to' | 'from', id: string, usage: string | null = null): Row[] {
    const marks = kinds.map(() => '?').join(', ');
    const col = direction === 'to' ? 'to_id' : 'from_id';
    return this.all(
      `select id, kind, from_id, to_id, usage, resolution, context, path, line, declared_target from relations where kind in (${marks}) and ${col} = ?${usage ? ' and usage = ?' : ''} order by path, line, id`,
      ...kinds,
      id,
      ...(usage ? [usage] : []),
    );
  }

  /**
   * References to an entity, one row per usage: through `relation_evidence` when the index has it (a .NET relation
   * aggregates several usages), else the relation's own first location.
   */
  references(id: string, usage: string | null): Row[] {
    const u = usage ? ' and r.usage = ?' : '';
    const p: (string | number)[] = usage ? [id, usage] : [id];
    if (this.tables.has('relation_evidence')) {
      return this.all(
        `select r.id, r.from_id, r.usage, e.context, e.path, e.line, e.text from relations r join relation_evidence re on re.relation = r.id join evidence e on e.id = re.evidence where r.kind = 'references' and r.to_id = ?${u} order by e.path, e.line, e.col, r.id`,
        ...p,
      );
    }
    return this.all(`select r.id, r.from_id, r.usage, r.context, r.path, r.line, null as text from relations r where r.kind = 'references' and r.to_id = ?${u} order by r.path, r.line, r.id`, ...p);
  }

  countRelations(kinds: string[], direction: 'to' | 'from', id: string): number {
    const marks = kinds.map(() => '?').join(', ');
    const col = direction === 'to' ? 'to_id' : 'from_id';
    return Number(this.one(`select count(*) as n from relations where kind in (${marks}) and ${col} = ?`, ...kinds, id)!.n);
  }

  /** Observations of the given kinds with their parsed JSON, ordered by location. Cached per kind set. */
  observations(kinds: string[]): Row[] {
    const key = `obs:${kinds.join(',')}`;
    if (!this.cache.has(key)) {
      const marks = kinds.map(() => '?').join(', ');
      const rows = this.all(`select id, kind, project, path, line, json from observations where kind in (${marks}) order by path, line, id`, ...kinds).map((r) => ({ ...JSON.parse(r.json), _path: r.path, _line: r.line }));
      this.cache.set(key, rows);
    }
    return this.cache.get(key) as Row[];
  }

  linksFrom(obsIds: string[]): Row[] {
    if (obsIds.length === 0) return [];
    const marks = obsIds.map(() => '?').join(', ');
    return this.all(`select * from links where from_obs in (${marks}) order by from_obs, id`, ...obsIds);
  }

  observation(id: string): Row | undefined {
    const r = this.one('select json, path, line from observations where id = ?', id);
    return r ? { ...JSON.parse(r.json), _path: r.path, _line: r.line } : undefined;
  }

  close(): void {
    this.db.close();
  }
}
