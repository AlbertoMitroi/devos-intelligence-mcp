// Bounded path search across code and services (contract v1.2 optional verb `trace`, same semantics as the .NET
// engine's query): calls between entities, observations made inside an entity (calls, publishes, sends, consumes),
// links between observations, and the entities that serve an observation (handler, implementation). Engine-neutral:
// only index.sql tables and contract fields. Each path reports its weakest link.
import type { IndexReader, Row } from './index-reader.ts';

export interface Step {
  to: string;
  kind: string;
  resolution: string;
  path: string | null;
  line: number | null;
}

export interface TracePath {
  to: string;
  steps: Step[];
  weakest: { resolution: string; step: number };
}

const STRENGTH = ['unresolved', 'candidate', 'ambiguous', 'exact'];
const rank = (r: string) => (STRENGTH.includes(r) ? STRENGTH.indexOf(r) : STRENGTH.length);

export const SERVICE_SIDE = new Set(['http.endpoint', 'grpc.service', 'messaging.subscribe', 'inprocess.handler', 'workflow.handler', 'realtime.subscribe']);
/** Observation fields naming the entity where the observed code runs. */
const SOURCE_FIELDS = ['caller', 'sender', 'publisher', 'consumer'];
/** Observation fields naming the entity that serves the observation. */
const TARGET_FIELDS = ['handler', 'handlerMethod', 'implementation'];

export class Tracer {
  r: IndexReader;
  madeIn: Map<string, Row[]> | null = null;

  constructor(r: IndexReader) {
    this.r = r;
  }

  isObservation(node: string): boolean {
    return node.startsWith('obs:') || node.includes('/obs:');
  }

  observationsMadeIn(entity: string): Row[] {
    if (!this.madeIn) {
      this.madeIn = new Map();
      for (const row of this.r.all('select id, kind, path, line, json from observations order by id')) {
        const o = this.r.located(row);
        const source = SOURCE_FIELDS.map((f) => o[f]).find((v) => typeof v === 'string');
        if (source) this.madeIn.set(source, [...(this.madeIn.get(source) ?? []), o]);
      }
    }
    return this.madeIn.get(entity) ?? [];
  }

  steps(node: string): Step[] {
    const out: Step[] = [];
    if (this.isObservation(node)) {
      for (const l of this.r.linksFrom([node])) {
        if (!l.to_obs) continue;
        const to = this.r.observation(l.to_obs);
        out.push({ to: l.to_obs, kind: `link.${l.kind}`, resolution: l.resolution, path: to?._path ?? null, line: to?._line ?? null });
      }
      const o = this.r.observation(node);
      for (const f of TARGET_FIELDS) {
        const entity = o?.[f];
        if (typeof entity === 'string' && this.r.entity(entity)) {
          const d = this.r.firstDeclaration(entity);
          out.push({ to: entity, kind: `${o!.kind}.${f}`, resolution: 'exact', path: d?.path ?? null, line: d?.line ?? null });
        }
      }
      return out;
    }
    for (const x of [...this.r.relations(['calls_declared_target', 'possible_runtime_target'], 'from', node), ...this.r.relations(['references'], 'from', node, 'invocation')]) {
      out.push({ to: x.to_id, kind: x.kind === 'references' ? 'invocation' : x.kind, resolution: x.resolution ?? 'exact', path: x.path, line: x.line });
    }
    for (const x of this.r.relations(['contains'], 'from', node)) out.push({ to: x.to_id, kind: 'contains', resolution: 'exact', path: x.path, line: x.line });
    for (const o of this.observationsMadeIn(node)) out.push({ to: o.id, kind: o.kind, resolution: o.resolution ?? 'exact', path: o._path, line: o._line });
    const seen = new Set<string>();
    return out.filter((s) => (seen.has(s.to) ? false : (seen.add(s.to), true)));
  }

  /** Breadth-first; with a target, the shortest paths at the first level that reaches it; without, every reachable service-side observation. */
  trace(start: string, isTarget: ((node: string) => boolean) | null, depth: number): TracePath[] {
    const target = isTarget ?? ((n: string) => n !== start && this.isObservation(n) && SERVICE_SIDE.has(this.r.observation(n)?.kind));
    const parent = new Map<string, { from: string; step: Step }>();
    const visited = new Set([start]);
    const reached: string[] = [];
    let frontier = [start];
    for (let level = 0; level < depth && frontier.length; level++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const s of this.steps(node)) {
          if (visited.has(s.to)) continue;
          visited.add(s.to);
          parent.set(s.to, { from: node, step: s });
          if (target(s.to)) {
            reached.push(s.to);
            if (isTarget) continue;
          }
          next.push(s.to);
        }
      }
      frontier = next.sort();
      if (isTarget && reached.length) break;
    }
    return reached.sort().map((end) => {
      const steps: Step[] = [];
      for (let n = end; n !== start; n = parent.get(n)!.from) steps.push(parent.get(n)!.step);
      steps.reverse();
      let w = 0;
      steps.forEach((s, i) => {
        if (rank(s.resolution) < rank(steps[w].resolution)) w = i;
      });
      return { to: end, steps, weakest: { resolution: steps[w].resolution, step: w + 1 } };
    });
  }

  /** `to` as an observation id, a project path, or an entity (a type is reached through any of its members). */
  targetOf(to: string, resolveEntity: (t: string) => string | null): ((node: string) => boolean) | string {
    if (this.isObservation(to)) return this.r.observation(to) ? (n: string) => n === to : `no observation ${to}`;
    const isProject = this.r.one('select 1 as x from entities where project = ? limit 1', to) || this.r.one('select 1 as x from observations where project = ? limit 1', to);
    if (isProject) return (n: string) => (this.isObservation(n) ? this.r.observation(n)?.project : this.r.entity(n)?.project) === to;
    const id = resolveEntity(to);
    if (!id) return `no entity or project '${to}'`;
    return (n: string) => n === id || (!this.isObservation(n) && this.r.entity(n)?.container === id);
  }
}
