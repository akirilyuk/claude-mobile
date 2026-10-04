import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';
import { createServer } from '../src/server.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

// Stand-in for the SDK's query(): asks permission for one Bash call per user message, then replies.
function fakeQuery({ prompt, options }) {
  const controller = new AbortController();
  async function* run() {
    yield { type: 'system', subtype: 'init', session_id: 'claude-1', model: 'fake' };
    for await (const msg of prompt) {
      const decision = await options.canUseTool('Bash', { command: 'ls' }, { signal: controller.signal, suggestions: [] });
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: `${decision.behavior}: ${msg.message.content}` }] },
      };
      yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0.01, result: 'ok' };
    }
  }
  const gen = run();
  gen.interrupt = async () => {};
  gen.close = () => controller.abort();
  return gen;
}

function setup() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-'));
  const store = new Store(workspace);
  return { workspace, store, manager: new SessionManager({ workspace, store, queryFn: fakeQuery }) };
}

test('session goes working -> needs_input -> idle and is persisted', async () => {
  const { workspace, store, manager } = setup();
  const meta = manager.create({ prompt: 'hello' });
  await tick();
  assert.equal(manager.list()[0].status, 'needs_input');

  const { events, pending } = manager.history(meta.id);
  assert.equal(pending.length, 1);
  assert.deepEqual(events.map((e) => e.kind), ['user', 'permission_request']);

  manager.resolvePermission(meta.id, pending[0], { decision: 'allow' });
  await tick();
  assert.equal(manager.list()[0].status, 'idle');
  assert.equal(manager.list()[0].claudeSessionId, 'claude-1');
  const kinds = store.readEvents(meta.id).map((e) => e.kind);
  assert.deepEqual(kinds, ['user', 'permission_request', 'permission_resolved', 'assistant', 'result']);
  assert.equal(store.readEvents(meta.id)[3].text, 'allow: hello');

  // A fresh manager (CLI restart) sees the session as stopped, with its history intact.
  manager.shutdown();
  const reloaded = new SessionManager({ workspace, store: new Store(workspace), queryFn: fakeQuery });
  assert.equal(reloaded.list()[0].status, 'closed');
  assert.equal(reloaded.history(meta.id).events.length, 5);
});

test('close cancels pending requests; delete removes files', async () => {
  const { store, manager } = setup();
  const meta = manager.create({ prompt: 'hi' });
  await tick();
  manager.close(meta.id);
  assert.equal(manager.list()[0].status, 'closed');
  assert.equal(store.readEvents(meta.id).at(-1).decision, 'cancelled');
  manager.remove(meta.id);
  assert.equal(manager.list().length, 0);
  assert.deepEqual(store.loadAll(), []);
});

test('server requires the password for the websocket and locks out after repeated failures', async () => {
  const { workspace, manager } = setup();
  const server = createServer({ password: 'correct horse', manager, workspace, publicDir: path.resolve('public') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `127.0.0.1:${server.address().port}`;
  const login = (password) =>
    fetch(`http://${base}/api/login`, { method: 'POST', body: JSON.stringify({ password }) });

  const denied = new WebSocket(`ws://${base}/ws`, { origin: `http://${base}` });
  const [err] = await once(denied, 'error');
  assert.match(err.message, /401/);

  assert.equal((await login('wrong')).status, 401);
  const ok = await login('correct horse');
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];

  // Right cookie but a foreign Origin is refused.
  const foreign = new WebSocket(`ws://${base}/ws`, { origin: 'http://evil.example', headers: { cookie } });
  assert.match((await once(foreign, 'error'))[0].message, /401/);

  const ws = new WebSocket(`ws://${base}/ws`, { origin: `http://${base}`, headers: { cookie } });
  const [first] = await once(ws, 'message');
  assert.equal(JSON.parse(first).t, 'sessions');
  ws.send(JSON.stringify({ t: 'open', id: 'nope' }));
  assert.equal(JSON.parse((await once(ws, 'message'))[0]).t, 'error');
  ws.close();

  for (let i = 0; i < 3; i++) assert.equal((await login('wrong')).status, 401);
  assert.equal((await login('correct horse')).status, 429);
  server.close();
});

test('terminal runs a shell in the workspace and keeps scrollback', async () => {
  const { TerminalManager } = await import('../src/terminals.js');
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-term-')));
  const terminals = new TerminalManager({ workspace });
  const info = terminals.create({ cols: 80, rows: 24 });
  assert.equal(info.status, 'running');

  terminals.write(info.id, 'pwd; exit 3\r');
  const [exited] = await once(terminals, 'terminal');
  assert.equal(exited.status, 'exited');
  assert.equal(exited.exitCode, 3);
  assert.ok(terminals.history(info.id).includes(workspace));

  terminals.remove(info.id);
  assert.deepEqual(terminals.list(), []);
});
