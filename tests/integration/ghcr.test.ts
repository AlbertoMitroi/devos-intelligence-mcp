// The real registry: the lab repositories publish their generation to ghcr.io on every push to main (public
// packages). Opt-in with DEVOS_IT_GHCR=1 because it needs the network and the published tags move with each push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.ts';
import { Registry } from '../../src/resolve/oci.ts';
import { Resolver } from '../../src/resolve/resolver.ts';
import { TOOLS, runTool } from '../../src/mcp/tools.ts';
import { GHCR, LAB_LEASING, LAB_LEASING_REMOTE, LAB_WEB, LAB_WEB_REMOTE, cloneAt, git } from './env.ts';
import { tmp } from '../helpers.ts';

const cases = [
  { repo: LAB_WEB, remote: LAB_WEB_REMOTE, name: 'albertomitroi/context-devos-lab-web', engine: 'angular', tool: 'http' },
  { repo: LAB_LEASING, remote: LAB_LEASING_REMOTE, name: 'albertomitroi/context-devos-lab-leasing', engine: 'dotnet', tool: 'routes' },
];

for (const c of cases) {
  test(`ghcr.io ${c.name}: anonymous pull of the latest <sha>-${c.engine}, exact and one commit ahead`, { skip: !GHCR || !c.repo ? 'DEVOS_IT_GHCR=1 and the lab repository are needed' : false, timeout: 120000 }, async () => {
    const tags = await new Registry('https://ghcr.io', c.name, { timeoutMs: 30000 }).tags();
    const tagged = tags.filter((t) => t.endsWith(`-${c.engine}`) && /^[0-9a-f]{40}-/.test(t)).map((t) => t.slice(0, 40));
    const commit = tagged.find((sha) => {
      try {
        git(c.repo, 'cat-file', '-e', `${sha}^{commit}`);
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(commit, `no published commit of ${c.name} is in the local repository (tags: ${tags.join(', ')})`);
    const dir = cloneAt(c.repo, commit!, c.remote);
    const env = { HOME: tmp('mcp-ghcr-home-'), DEVOS_MCP_GENERATIONS: '', DOCKER_CONFIG: tmp('mcp-ghcr-docker-'), PATH: '/usr/bin:/bin' };
    const res = await new Resolver(loadConfig(env), undefined, env).resolve(dir);
    assert.ok(!('error' in res));
    assert.equal(res.loaded.length, 1, [...res.sources, ...res.skipped, ...res.errors].join('\n'));
    assert.equal(res.loaded[0].source, 'oci');
    assert.match(res.sources.join('\n'), /oci: ghcr.io\/albertomitroi\/context-devos-lab-\w+ \(anonymous\)/);
    const out = runTool(TOOLS.find((t) => t.name === c.tool)!, res, { limit: 3 });
    assert.match(out.text, /^generation devos-lab-\w+-\w+ .* exact match for HEAD\n/);

    git(dir, 'commit', '-q', '--allow-empty', '-m', 'ahead');
    const ahead = await new Resolver(loadConfig(env), undefined, env).resolve(dir);
    assert.ok(!('error' in ahead));
    assert.equal(ahead.loaded[0]?.source, 'cache');
    assert.match(runTool(TOOLS.find((t) => t.name === c.tool)!, ahead, {}).text, /^WARNING .* \(1 commit\(s\) behind\)/);
  });
}
