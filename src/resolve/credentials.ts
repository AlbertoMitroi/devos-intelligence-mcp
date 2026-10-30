// Registry credentials (decision M6): the `context-*` packages start private, so a pull needs a token with
// `read:packages`. Order: environment, Docker configuration (inline `auths`, then `credHelpers`, then `credsStore`
// through `docker-credential-<helper> get`), then `gh auth token` for ghcr.io. Looked up only after an anonymous
// attempt was refused; values are never logged or put in answers, only where they came from.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Credentials {
  user: string;
  secret: string;
  /** Where they came from, for diagnostics: `env`, `docker auths`, `docker-credential-desktop`, `gh`. */
  source: string;
}

function helper(name: string, host: string, env: NodeJS.ProcessEnv): Credentials | null {
  try {
    const out = execFileSync(`docker-credential-${name}`, ['get'], { input: host, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], env, timeout: 10000 });
    const j = JSON.parse(out) as { Username?: string; Secret?: string };
    return j.Secret ? { user: j.Username || 'token', secret: j.Secret, source: `docker-credential-${name}` } : null;
  } catch {
    return null;
  }
}

export function fromDockerConfig(host: string, env: NodeJS.ProcessEnv): Credentials | null {
  const path = join(env.DOCKER_CONFIG || join(env.HOME || homedir(), '.docker'), 'config.json');
  if (!existsSync(path)) return null;
  let cfg: { auths?: Record<string, { auth?: string }>; credHelpers?: Record<string, string>; credsStore?: string };
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const keys = [host, `https://${host}`, `https://${host}/v1/`, `https://${host}/v2/`];
  for (const k of keys) {
    const auth = cfg.auths?.[k]?.auth;
    if (auth) {
      const plain = Buffer.from(auth, 'base64').toString('utf8');
      const i = plain.indexOf(':');
      if (i > 0) return { user: plain.slice(0, i), secret: plain.slice(i + 1), source: 'docker auths' };
    }
  }
  const named = cfg.credHelpers?.[host];
  if (named) return helper(named, host, env);
  if (cfg.credsStore) return helper(cfg.credsStore, host, env);
  return null;
}

export function fromGh(host: string, env: NodeJS.ProcessEnv): Credentials | null {
  if (host !== 'ghcr.io') return null;
  try {
    const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env, timeout: 10000 }).trim();
    return token ? { user: 'token', secret: token, source: 'gh' } : null;
  } catch {
    return null;
  }
}

export function fromEnv(env: NodeJS.ProcessEnv): Credentials | null {
  const secret = env.DEVOS_MCP_REGISTRY_TOKEN || env.GHCR_TOKEN;
  return secret ? { user: env.DEVOS_MCP_REGISTRY_USER || 'token', secret, source: 'env' } : null;
}

/** Every configured source, in order; the caller tries them one by one until the registry accepts one. */
export function credentialCandidates(host: string, env: NodeJS.ProcessEnv = process.env): (() => Credentials | null)[] {
  return [() => fromEnv(env), () => fromDockerConfig(host, env), () => fromGh(host, env)];
}
