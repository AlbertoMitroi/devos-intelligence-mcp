// Integration test inputs, from the environment set by scripts/verify.sh (Docker mounts) or by hand on the host.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '../helpers.ts';

export const GENERATIONS = process.env.DEVOS_IT_GENERATIONS ?? '';
export const LAB_WEB = process.env.DEVOS_IT_LAB_WEB ?? '';
export const ESHOP = process.env.DEVOS_IT_ESHOP ?? '';
export const LAB_LEASING = process.env.DEVOS_IT_LAB_LEASING ?? '';
export const CONTRACT = process.env.DEVOS_IT_CONTRACT ?? '';
/** `1`: also pull the lab generations from the real ghcr.io (anonymous; the packages are public). */
export const GHCR = process.env.DEVOS_IT_GHCR === '1';
export const REGISTRY = process.env.DEVOS_IT_REGISTRY ?? '';
export const TRANSCRIPT = process.env.DEVOS_IT_TRANSCRIPT ?? '';

/** The commit of the local lab-web generation (regenerated as the engines evolve); e21eef1 when none is mounted. */
export const LAB_WEB_COMMIT: string = (() => {
  const manifest = join(GENERATIONS, 'lab-web-angular', 'manifest.json');
  return GENERATIONS && existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).commit : 'e21eef1712b25463d61687efc2f547d9dc0949f1';
})();
export const LAB_WEB_REMOTE = 'https://github.com/AlbertoMitroi/devos-lab-web.git';
export const ESHOP_COMMIT = '7bfed7a322d16b34a5a66208c03486fa5dfacee9';
export const LAB_LEASING_REMOTE = 'https://github.com/AlbertoMitroi/devos-lab-leasing.git';

export function skipUnless(...paths: string[]): string | false {
  const missing = paths.filter((p) => !p || !existsSync(p));
  return missing.length ? `inputs missing (set DEVOS_IT_* or run scripts/verify.sh): ${missing.join(', ') || '(unset)'}` : false;
}

/** A writable clone of `source` checked out at `commit`, with the original remote URL, plus `extra` commits on top. */
export function cloneAt(source: string, commit: string, remote: string): string {
  const dir = join(tmp('mcp-it-'), 'repo');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  execFileSync('git', ['clone', '-q', '--no-checkout', source, dir], { stdio: 'ignore' });
  git('checkout', '-q', commit);
  git('remote', 'set-url', 'origin', remote);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  return dir;
}

export function git(dir: string, ...a: string[]): string {
  return execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
}
