import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '../../src/mcp/server.ts';
import { gitRepo, testConfig, tmp, writeGeneration } from '../helpers.ts';

/** Drives the server over in-memory streams like a client would: one JSON object per line. */
function harness(server: McpServer, input: PassThrough, output: PassThrough) {
  const received: any[] = [];
  const waiters: [(m: any) => boolean, (m: any) => void][] = [];
  let buf = '';
  output.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      received.push(msg);
      for (const w of [...waiters]) if (w[0](msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w[1](msg);
      }
    }
  });
  const done = server.serve(input);
  const next = (pred: (m: any) => boolean) => new Promise<any>((resolve) => {
    const hit = received.find(pred);
    if (hit) resolve(hit);
    else waiters.push([pred, resolve]);
  });
  const send = (m: object) => input.write(JSON.stringify(m) + '\n');
  const request = (id: number, method: string, params: object = {}) => {
    send({ jsonrpc: '2.0', id, method, params });
    return next((m) => m.id === id);
  };
  return { send, request, next, done, received };
}

test('stdio: initialize, tools/list, tools/call, errors; workspace from client roots', async () => {
  const { dir, commits } = gitRepo(1);
  const folder = tmp();
  writeGeneration(join(folder, 'shop-angular'), { commit: commits[0] });
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new McpServer(testConfig({ generationRoots: [folder] }), output);
  const h = harness(server, input, output);

  const init = await h.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'devos-intelligence-mcp');

  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const rootsReq = await h.next((m) => m.method === 'roots/list');
  h.send({ jsonrpc: '2.0', id: rootsReq.id, result: { roots: [{ uri: pathToFileURL(dir).href, name: 'shop' }] } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.workspaceDir(), dir);

  const list = await h.request(2, 'tools/list');
  assert.equal(list.result.tools.length, 12);
  assert.ok(list.result.tools.every((t: any) => t.inputSchema.type === 'object' && t.description.length > 20));

  const call = await h.request(3, 'tools/call', { name: 'routes', arguments: {} });
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /^generation shop-angular .*exact match for HEAD\nHTTP GET \/v1\/orders[\s\S]*\nUI {3}\/orders/);

  const unknownTool = await h.request(4, 'tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = await h.request(5, 'resources/list');
  assert.equal(unknownMethod.error.code, -32601);
  assert.deepEqual((await h.request(6, 'ping')).result, {});
  const old = await h.request(7, 'initialize', { protocolVersion: '1999-01-01', capabilities: {} });
  assert.equal(old.result.protocolVersion, '2025-11-25');

  input.write('not json\n');
  const parseError = await h.next((m) => m.error?.code === -32700);
  assert.equal(parseError.id, null);
  input.end();
  await h.done;
  assert.ok(h.received.every((m) => m.jsonrpc === '2.0'));
});

test('stdio: no generation gives an explanation, as an error except for generation_info', async () => {
  const { dir } = gitRepo(1);
  const input = new PassThrough();
  const output = new PassThrough();
  const h = harness(new McpServer(testConfig({ workspace: dir }), output), input, output);
  const r1 = await h.request(1, 'tools/call', { name: 'symbol', arguments: { symbol: 'x' } });
  assert.equal(r1.result.isError, true);
  assert.match(r1.result.content[0].text, /^no generation for git@github.com:Example\/Shop.git at HEAD [0-9a-f]{12} or its 50 nearest/);
  const r2 = await h.request(2, 'tools/call', { name: 'generation_info', arguments: {} });
  assert.equal(r2.result.isError, false);
  assert.match(r2.result.content[0].text, /sources tried:\n {2}local: \(no folder\)/);
  input.end();
  await h.done;
});
