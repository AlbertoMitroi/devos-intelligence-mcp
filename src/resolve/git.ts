// Git facts of the agent's working repository (PLAN, resolution rules 1 to 3). Read-only commands only.
import { execFileSync } from 'node:child_process';

export interface Workspace {
  dir: string;
  root: string;
  head: string;
  remoteUrl: string | null;
  /** `owner/name` from the remote, lower case, when the remote is a recognizable host path. */
  slug: { host: string; owner: string; name: string } | null;
}

function git(cwd: string, args: string[], trim = true): string | null {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return trim ? out.trim() : out;
  } catch {
    return null;
  }
}

/** `https://github.com/Owner/Repo.git`, `git@github.com:Owner/Repo`, `ssh://git@github.com/Owner/Repo` → `github.com/owner/repo`. */
export function normalizeRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = url.trim();
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
  u = u.replace(/:\d+(?=\/)/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  return u.toLowerCase() || null;
}

export function slugOf(remote: string | null): Workspace['slug'] {
  const n = normalizeRemote(remote);
  if (!n) return null;
  const parts = n.split('/');
  if (parts.length < 3) return null;
  return { host: parts[0], owner: parts[parts.length - 2], name: parts[parts.length - 1] };
}

export function readWorkspace(dir: string): Workspace | { error: string } {
  const root = git(dir, ['rev-parse', '--show-toplevel']);
  if (!root) return { error: `'${dir}' is not inside a Git working tree (or git is not available)` };
  const head = git(root, ['rev-parse', 'HEAD']);
  if (!head) return { error: `'${root}' has no commit yet` };
  const remoteUrl = git(root, ['config', '--get', 'remote.origin.url']) || null;
  return { dir, root, head, remoteUrl, slug: slugOf(remoteUrl) };
}

/** HEAD and its first-parent ancestors, nearest first, at most `max + 1` commits. */
export function candidates(root: string, max: number): string[] {
  const out = git(root, ['rev-list', '--first-parent', `--max-count=${max + 1}`, 'HEAD']);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Commits reachable from HEAD but not from `commit`. */
export function distanceTo(root: string, commit: string): number {
  return Number(git(root, ['rev-list', '--count', `${commit}..HEAD`]) ?? NaN);
}

export function isAncestor(root: string, commit: string, of = 'HEAD'): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, of], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Files that differ between `commit` and the working tree (committed changes plus uncommitted ones), repository-relative. */
export function changedSince(root: string, commit: string): { files: Set<string>; dirty: boolean; known: boolean } {
  const files = new Set<string>();
  // Porcelain lines start with a two-letter status that may begin with a space: never trim them.
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=normal'], false);
  const dirty = !!status?.trim();
  for (const line of (status ?? '').split('\n').filter(Boolean)) {
    const path = line.slice(3);
    for (const p of path.split(' -> ')) files.add(p.replace(/^"|"$/g, ''));
  }
  const diff = git(root, ['diff', '--name-only', commit, 'HEAD']);
  if (diff == null) return { files, dirty, known: false };
  for (const p of diff.split('\n').filter(Boolean)) files.add(p);
  return { files, dirty, known: true };
}
