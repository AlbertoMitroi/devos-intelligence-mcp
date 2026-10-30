// Configuration from the environment (PLAN, resolution rules). Every value has a default that works on the owner's
// machine. Registry credentials are not configuration: src/resolve/credentials.ts looks them up when needed.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  workspace: string | null;
  generationRoots: string[];
  cacheDir: string;
  maxAncestors: number;
  /** System generations: `auto` (any found whose inputs include this repository), `off`, or one folder. */
  system: string;
  oci: {
    enabled: boolean;
    /** `ghcr.io/{owner}/context-{repo}`; an `http://` prefix means a plain-HTTP registry (tests). */
    reference: string;
    maxBytes: number;
    timeoutMs: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME ?? homedir();
  const defaultRoot = join(home, 'repos', 'devos', '_generations');
  const roots = env.DEVOS_MCP_GENERATIONS !== undefined
    ? env.DEVOS_MCP_GENERATIONS.split(':').filter(Boolean)
    : existsSync(defaultRoot) ? [defaultRoot] : [];
  const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
  return {
    workspace: env.DEVOS_MCP_WORKSPACE || null,
    generationRoots: roots,
    cacheDir: env.DEVOS_MCP_CACHE || join(env.XDG_CACHE_HOME || join(home, '.cache'), 'devos-intelligence-mcp'),
    maxAncestors: int(env.DEVOS_MCP_MAX_ANCESTORS, 50),
    system: env.DEVOS_MCP_SYSTEM || 'auto',
    oci: {
      enabled: (env.DEVOS_MCP_OCI ?? 'on') !== 'off',
      reference: env.DEVOS_MCP_OCI_REFERENCE || 'ghcr.io/{owner}/context-{repo}',
      maxBytes: int(env.DEVOS_MCP_OCI_MAX_BYTES, 1024 * 1024 * 1024),
      timeoutMs: int(env.DEVOS_MCP_OCI_TIMEOUT_MS, 30000),
    },
  };
}
