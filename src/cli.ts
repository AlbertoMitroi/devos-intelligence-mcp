#!/usr/bin/env node
// Entry point: serve (MCP stdio, default), resolve, call, verify.
import { resolve as resolvePath } from 'node:path';
import { loadConfig } from './config.ts';
import { McpServer, SERVER_INFO } from './mcp/server.ts';
import { Resolver } from './resolve/resolver.ts';
import { TOOLS, noGeneration, runTool } from './mcp/tools.ts';
import { verifyGeneration } from './generation/verify.ts';

const USAGE = `${SERVER_INFO.name} ${SERVER_INFO.version}

Usage:
  devos-intelligence-mcp [serve]                 MCP server over stdio
  devos-intelligence-mcp resolve [dir]           which generation answers for the repository at dir (default: cwd)
  devos-intelligence-mcp call <tool> [json] [--dir dir]   one tool call, answer on stdout
  devos-intelligence-mcp verify <generation>     manifest and file checks of a generation folder
  devos-intelligence-mcp tools                   tool names

Environment: DEVOS_MCP_WORKSPACE, DEVOS_MCP_GENERATIONS, DEVOS_MCP_CACHE, DEVOS_MCP_MAX_ANCESTORS,
DEVOS_MCP_OCI (on|off), DEVOS_MCP_OCI_REFERENCE, DEVOS_MCP_REGISTRY_USER, DEVOS_MCP_REGISTRY_TOKEN (see docs/USAGE.md).
`;

async function main(argv: string[]): Promise<number> {
  const [cmd = 'serve', ...rest] = argv;
  const cfg = loadConfig();
  const dirFlag = rest.indexOf('--dir');
  const dir = dirFlag >= 0 ? resolvePath(rest[dirFlag + 1]) : cfg.workspace ?? process.cwd();
  switch (cmd) {
    case 'serve': {
      const server = new McpServer(cfg, process.stdout);
      process.stderr.write(`${SERVER_INFO.name} ${SERVER_INFO.version}: serving MCP on stdio\n`);
      await server.serve(process.stdin);
      return 0;
    }
    case 'resolve':
    case 'call': {
      const resolver = new Resolver(cfg);
      const at = cmd === 'resolve' && rest[0] && !rest[0].startsWith('--') ? resolvePath(rest[0]) : dir;
      const res = await resolver.resolve(at);
      if ('error' in res) {
        process.stderr.write(res.error + '\n');
        return 2;
      }
      if (res.loaded.length === 0) {
        process.stdout.write(noGeneration(res, cfg.maxAncestors) + '\n');
        return 4;
      }
      const name = cmd === 'resolve' ? 'generation_info' : rest[0];
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        process.stderr.write(`unknown tool '${name ?? ''}' (${TOOLS.map((t) => t.name).join(', ')})\n`);
        return 2;
      }
      const json = cmd === 'call' && rest[1] && !rest[1].startsWith('--') ? JSON.parse(rest[1]) : {};
      const out = runTool(tool, res, json);
      process.stdout.write(out.text + '\n');
      return out.isError ? 1 : 0;
    }
    case 'verify': {
      if (!rest[0]) {
        process.stderr.write(USAGE);
        return 2;
      }
      const v = await verifyGeneration(resolvePath(rest[0]));
      for (const e of v.errors) process.stdout.write(`error: ${e}\n`);
      for (const n of v.notes) process.stdout.write(`note: ${n}\n`);
      process.stdout.write(v.ok ? `ok: ${v.manifest!.engine?.name} ${v.manifest!.commit}\n` : 'failed\n');
      return v.ok ? 0 : 1;
    }
    case 'tools':
      process.stdout.write(TOOLS.map((t) => t.name).join('\n') + '\n');
      return 0;
    case '--help':
    case 'help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    case '--version':
      process.stdout.write(`${SERVER_INFO.version}\n`);
      return 0;
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`${(e as Error).stack ?? e}\n`);
    process.exitCode = 70;
  },
);
