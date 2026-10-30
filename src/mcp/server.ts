// MCP over stdio (PLAN M3): newline-delimited JSON-RPC 2.0. Requests handled: initialize, ping, tools/list,
// tools/call; the server asks the client for roots/list once after initialization when the client declares roots.
// Nothing but protocol messages is written to stdout; diagnostics go to stderr.
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import type { Config } from '../config.ts';
import { Resolver } from '../resolve/resolver.ts';
import { TOOLS, noGeneration, runTool } from './tools.ts';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'devos-intelligence-mcp', version: '0.1.0' };

const INSTRUCTIONS = [
  'Answers come from a precomputed code-intelligence generation of the repository you work in (semantic graph with file:line evidence),',
  'not from the live files. Every answer starts with a header: if it says WARNING, the generation is for an older commit or the',
  'working tree changed, and locations marked [changed] may have moved. Start with generation_info or context, then search/symbol,',
  'refs, callers, callees, implementations, di, routes, http and who_calls. Results are paged: pass the cursor to see more.',
].join(' ');

type Json = Record<string, any>;

export class McpServer {
  cfg: Config;
  resolver: Resolver;
  out: Writable;
  roots: string[] = [];
  clientCanRoots = false;
  nextId = 1;
  pending = new Map<string | number, (msg: Json) => void>();

  constructor(cfg: Config, out: Writable, resolver?: Resolver) {
    this.cfg = cfg;
    this.out = out;
    this.resolver = resolver ?? new Resolver(cfg);
  }

  send(msg: Json): void {
    this.out.write(JSON.stringify(msg) + '\n');
  }

  workspaceDir(): string {
    return this.cfg.workspace ?? this.roots[0] ?? process.cwd();
  }

  async requestRoots(): Promise<void> {
    const id = `srv-${this.nextId++}`;
    const reply = new Promise<Json>((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.delete(id)) resolve({ error: { message: 'timeout' } });
      }, 5000).unref();
    });
    this.send({ jsonrpc: '2.0', id, method: 'roots/list' });
    const msg = await reply;
    const roots = (msg.result?.roots ?? []) as { uri: string }[];
    this.roots = roots.filter((r) => r.uri?.startsWith('file://')).map((r) => fileURLToPath(r.uri));
  }

  async handle(msg: Json): Promise<Json | null> {
    if (msg.id !== undefined && msg.method === undefined) {
      // Response to a request the server made.
      const done = this.pending.get(msg.id);
      if (done) {
        this.pending.delete(msg.id);
        done(msg);
      }
      return null;
    }
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      const result = await this.dispatch(msg.method, msg.params ?? {});
      return isRequest ? { jsonrpc: '2.0', id: msg.id, result } : null;
    } catch (e) {
      const err = e as Error & { code?: number };
      return isRequest ? { jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } } : null;
    }
  }

  async dispatch(method: string, params: Json): Promise<Json | undefined> {
    switch (method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '');
        this.clientCanRoots = !!params.capabilities?.roots;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
      }
      case 'notifications/initialized':
        if (this.clientCanRoots && !this.cfg.workspace) this.requestRoots().catch(() => undefined);
        return undefined;
      case 'notifications/roots/list_changed':
        if (!this.cfg.workspace) this.requestRoots().catch(() => undefined);
        return undefined;
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
      case 'tools/call':
        return this.call(String(params.name ?? ''), (params.arguments ?? {}) as Json);
      default:
        if (method?.startsWith('notifications/')) return undefined;
        throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
    }
  }

  async call(name: string, args: Json): Promise<Json> {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], isError });
    try {
      const res = await this.resolver.resolve(this.workspaceDir());
      if ('error' in res) return text(res.error, true);
      if (res.loaded.length === 0) return text(noGeneration(res, this.cfg.maxAncestors), name !== 'generation_info');
      const out = runTool(tool, res, args);
      return text(out.text, out.isError);
    } catch (e) {
      return text(`internal error in ${name}: ${(e as Error).message}`, true);
    }
  }

  /** Reads the input until it ends; requests run concurrently, responses are written as they complete. */
  serve(input: Readable): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Infinity });
    const inflight = new Set<Promise<void>>();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        return;
      }
      const p = this.handle(msg).then((reply) => {
        if (reply) this.send(reply);
      });
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    });
    return new Promise((resolve) => rl.on('close', () => Promise.allSettled([...inflight]).then(() => resolve())));
  }
}
