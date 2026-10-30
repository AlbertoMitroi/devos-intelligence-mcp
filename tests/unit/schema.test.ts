import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { indexSchema, INDEX_SQL } from '../../src/generation/index-schema.ts';

const vendorPath = fileURLToPath(new URL('../../schema/VENDOR.json', import.meta.url));

test('vendored index.sql has not drifted from schema/VENDOR.json', () => {
  const vendor = JSON.parse(readFileSync(vendorPath, 'utf8'));
  assert.deepEqual(readdirSync(fileURLToPath(new URL('.', INDEX_SQL))).sort(), Object.keys(vendor.files).sort());
  const sha = createHash('sha256').update(readFileSync(INDEX_SQL)).digest('hex');
  assert.equal(sha, vendor.files['index.sql'], `index.sql differs from devos-intelligence-contract ${vendor.tag} (${vendor.commit})`);
});

test('index.sql sections: base, optional evidence, system', () => {
  const s = indexSchema();
  assert.deepEqual(s.tables.base, ['meta', 'entities', 'declarations', 'evidence', 'relations', 'observations', 'links', 'diagnostics', 'projects', 'search']);
  assert.deepEqual(s.tables.evidence, ['relation_evidence', 'observation_evidence', 'link_evidence', 'evidence_snippet']);
  assert.deepEqual(s.tables.system, ['inputs', 'packages', 'traces']);
  assert.ok(s.statements.base.every((x) => x.endsWith(';')));
});
