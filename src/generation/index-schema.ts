// The normative index schema (contract v1.2, `schema/index/v1/index.sql`, vendored with schema/VENDOR.json): which
// tables a reader may require (section `base`), use when present (`evidence`) or meet in a system generation (`system`).
import { readFileSync } from 'node:fs';

export type Section = 'base' | 'evidence' | 'system';

export interface IndexSchema {
  /** Statements per section, as written in index.sql. */
  statements: Record<Section, string[]>;
  /** Table names per section (virtual tables included). */
  tables: Record<Section, string[]>;
}

export const INDEX_SQL = new URL('../../schema/index/v1/index.sql', import.meta.url);

export function parseIndexSql(text: string): IndexSchema {
  const statements: Record<Section, string[]> = { base: [], evidence: [], system: [] };
  let section: Section | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = /^--\s*(base|evidence|system)\s*$/.exec(line);
    if (header) section = header[1] as Section;
    else if (line && !line.startsWith('--') && section) statements[section].push(line);
  }
  const tablesOf = (xs: string[]) => xs.map((s) => /^create (?:virtual )?table (\w+)/.exec(s)?.[1]).filter((t): t is string => !!t);
  return { statements, tables: { base: tablesOf(statements.base), evidence: tablesOf(statements.evidence), system: tablesOf(statements.system) } };
}

let cached: IndexSchema | null = null;

export function indexSchema(): IndexSchema {
  cached ??= parseIndexSql(readFileSync(INDEX_SQL, 'utf8'));
  return cached;
}
