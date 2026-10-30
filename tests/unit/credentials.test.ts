import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialCandidates, fromDockerConfig, fromEnv, fromGh } from '../../src/resolve/credentials.ts';
import { tmp } from '../helpers.ts';

/** A folder with fake `docker-credential-fake` and `gh` executables, and a Docker config folder. */
function fakes(config: object | null): NodeJS.ProcessEnv {
  const bin = tmp('mcp-bin-');
  writeFileSync(join(bin, 'docker-credential-fake'), '#!/bin/sh\nread host\n[ "$1" = get ] && [ "$host" = ghcr.io ] && printf \'{"ServerURL":"ghcr.io","Username":"octo","Secret":"from-helper"}\' || exit 1\n');
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\n[ "$1 $2" = "auth token" ] && echo from-gh\n');
  chmodSync(join(bin, 'docker-credential-fake'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  const docker = tmp('mcp-docker-');
  if (config) writeFileSync(join(docker, 'config.json'), JSON.stringify(config));
  return { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp('mcp-home-'), DOCKER_CONFIG: docker };
}

test('credentials: environment first, then Docker auths, helpers, credsStore, then gh', () => {
  assert.deepEqual(fromEnv({ DEVOS_MCP_REGISTRY_TOKEN: 's', DEVOS_MCP_REGISTRY_USER: 'u' }), { user: 'u', secret: 's', source: 'env' });
  assert.deepEqual(fromEnv({ GHCR_TOKEN: 'g' }), { user: 'token', secret: 'g', source: 'env' });
  assert.equal(fromEnv({}), null);

  const inline = fakes({ auths: { 'ghcr.io': { auth: Buffer.from('me:inline-secret').toString('base64') } }, credsStore: 'fake' });
  assert.deepEqual(fromDockerConfig('ghcr.io', inline), { user: 'me', secret: 'inline-secret', source: 'docker auths' });

  const helper = fakes({ auths: { 'other.io': {} }, credHelpers: { 'ghcr.io': 'fake' } });
  assert.deepEqual(fromDockerConfig('ghcr.io', helper), { user: 'octo', secret: 'from-helper', source: 'docker-credential-fake' });

  const store = fakes({ credsStore: 'fake' });
  assert.deepEqual(fromDockerConfig('ghcr.io', store), { user: 'octo', secret: 'from-helper', source: 'docker-credential-fake' });
  assert.equal(fromDockerConfig('quay.io', store), null, 'the helper has nothing for another host');
  assert.equal(fromDockerConfig('ghcr.io', fakes(null)), null);
  assert.equal(fromDockerConfig('ghcr.io', fakes({ credsStore: 'missing' })), null);

  assert.deepEqual(fromGh('ghcr.io', store), { user: 'token', secret: 'from-gh', source: 'gh' });
  assert.equal(fromGh('registry.example.com', store), null, 'gh tokens are only offered to ghcr.io');

  const order = credentialCandidates('ghcr.io', { ...store, GHCR_TOKEN: 'e' }).map((f) => f()?.source);
  assert.deepEqual(order, ['env', 'docker-credential-fake', 'gh']);
});
