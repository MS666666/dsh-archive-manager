import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as plugin from '../../lib/index.js';
import { deleteSessionFromMenu, listArchivedSessions, reconcileDeletedSessions } from '../../lib/routes.js';
const runtime = new URL('../../.compat-runtime/node_modules/', import.meta.url);
const available = existsSync(new URL('@deepseek-ai/dsh-agent-loop/lib/index.js', runtime));
const pkg = name => import(new URL(`@deepseek-ai/${name}/lib/index.js`, runtime));

async function boot(home, compression = 'none') {
  const { Context } = await pkg('cordis'); const ctx = new Context(); const routes = new Map();
  const mount = async (name, config) => {
    const mod = await pkg(name); await ctx.plugin(mod.default ?? mod, config).await();
  };
  ctx.provide('webServer', { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } });
  await mount('dsh-storage');
  await mount('dsh-storage-json', { root: join(home, 'storages') });
  await mount('dsh-storage-domain', { backend: 'json' });
  await mount('dsh-session'); await mount('dsh-agent'); await mount('dsh-session-projection');
  await mount('dsh-system-prompt'); await mount('dsh-tools'); await mount('dsh-tool-executor-native'); await mount('dsh-llm');
  await mount('dsh-session-persistence-jsonl', { root: join(home, 'sessions'), compression });
  await mount('dsh-workspace');
  await mount('dsh-session-projection-cache', { writeEveryEvents: 1, writeIntervalMs: 10 });
  await mount('dsh-agent-loop', { agents: [], maxParallelToolCalls: 10 });
  await ctx.plugin(plugin).await();
  return { ctx, routes, close: () => ctx.fiber.dispose() };
}

async function call(routes, path, data, origin = 'http://localhost') {
  const request = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]);
  request.method = data === undefined ? 'GET' : 'POST'; request.headers = { host: 'localhost', origin };
  let status; let body;
  await routes.get(path).handler(request, { writeHead: value => { status = value; }, end: value => { body = value ? JSON.parse(value) : null; } });
  return { status, body };
}

const deletedId = 'session-aabbccdd-1111-4444-9999-000000000001';
const keptId = 'session-aabbccdd-1111-4444-9999-000000000002';

test('official 0.2.2-rc.1: real host, routes, cache, workspace, stop, deletion and restart', { skip: !available }, async t => {
  const home = mkdtempSync(join(process.cwd(), '.integration-'));
  const cwd = join(home, 'work'); mkdirSync(cwd);
  let host = await boot(home);
  t.after(async () => { await host.close(); rmSync(home, { recursive: true, force: true }); });
  const { ctx, routes } = host;
  const workspace = await ctx.workspaceRegistry.create(cwd);
  for (const id of [deletedId, keptId]) {
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions: {} });
    handle.agent.session.append('test/archive', { text: 'temporary integration session' });
    await ctx.sessions.flush(handle.agent.session);
    await workspace.attachSession(id);
    await ctx.sessionProjectionCache.write(handle.agent.session);
  }
  const session = ctx.sessions.get(deletedId);
  const agent = ctx.agents.get(deletedId);
  // Native maintenance is real cancellable in-flight work, not a fake Agent.
  const maintenance = agent.runMaintenance(signal => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })));
  const events = []; ctx.on('api-session/removed', id => events.push(id));
  const ledger = join(home, 'storages', 'ledger-test.json'); writeFileSync(ledger, '{"historicalCost":123}');
  const rejected = await call(routes, '/dsh-archive-manager-plus/delete', { sessionId: deletedId, archiveFirst: true }, 'https://untrusted.invalid');
  assert.equal(rejected.status, 403); assert.ok(ctx.sessions.get(deletedId));
  const result = await call(routes, '/dsh-archive-manager-plus/delete', { sessionId: deletedId, archiveFirst: true });
  assert.deepEqual(result, { status: 200, body: { ok: true, deleted: true } });
  await maintenance;
  assert.equal(ctx.sessions.get(deletedId), undefined); assert.equal(ctx.agents.get(deletedId), undefined);
  assert.equal(workspace.sessionIds.includes(deletedId), false); assert.ok(workspace.sessionIds.includes(keptId));
  assert.ok(events.includes(deletedId)); assert.deepEqual(listArchivedSessions(ctx), []);
  await ctx.sessionPersistence.flush();
  // Let the official write-behind callbacks settle; they must not recreate a removed cache row.
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(ctx.storageDomain.get('session_projcache').table('sessions').get(deletedId), undefined);
  assert.equal(existsSync(join(home, 'storages', 'session_projcache', 'sessions', `${deletedId}.json`)), false);
  assert.equal((await ctx.sessionPersistence.list()).some(record => (record.header?.id ?? record.id) === deletedId), false);
  assert.equal(readFileSync(ledger, 'utf8'), '{"historicalCost":123}');
  await ctx.workspaceRegistry.requireTable().update(workspace.id, record => ({ ...record, sessionIds: [deletedId, keptId] }));
  await ctx.workspaceRegistry.setState({ ...ctx.workspaceRegistry.requireState(), archivedSessionIds: [deletedId] });
  await reconcileDeletedSessions(ctx); assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, []);
  assert.equal(ctx.workspaceRegistry.requireTable().get(workspace.id).sessionIds.includes(deletedId), false);
  await assert.rejects(ctx.agents.create({ sessionId: deletedId, meta: { cwd }, agentOptions: {} }), /删除/);
  assert.equal(ctx.sessions.get(deletedId), undefined);
  await host.close();
  host = await boot(home);
  const restarted = host.ctx;
  const refreshed = await call(host.routes, '/dsh-archive-manager-plus/list');
  assert.deepEqual(refreshed, { status: 200, body: { ok: true, sessions: [] } });
  assert.deepEqual(listArchivedSessions(restarted), []);
  assert.equal(restarted.workspaceRegistry.list().some(ws => ws.sessionIds.includes(deletedId)), false);
  assert.equal(restarted.workspaceRegistry.list().some(ws => ws.sessionIds.includes(keptId)), true);
  assert.equal(restarted.storageDomain.get('session_projcache').table('sessions').get(deletedId), undefined);
  assert.equal(readFileSync(ledger, 'utf8'), '{"historicalCost":123}');
});
test('official 0.2.2-rc.1: stop a running model turn and delete without network access', { skip: !available, timeout: 10000 }, async t => {
  const home = mkdtempSync(join(process.cwd(), '.integration-running-'));
  const cwd = join(home, 'work'); mkdirSync(cwd);
  const host = await boot(home, 'zstd'); const { ctx } = host;
  t.after(async () => { await host.close(); rmSync(home, { recursive: true, force: true }); });
  const { LlmAdapter, createUserMessage } = await pkg('dsh-llm');
  const started = Promise.withResolvers(); let aborted = false;
  ctx.on('agent/error', payload => started.reject(payload.error ?? new Error(JSON.stringify(payload))));
  class OfflineAdapter extends LlmAdapter {
    async *stream(options) {
      started.resolve();
      await new Promise(resolve => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener('abort', resolve, { once: true });
      });
      aborted = true;
      options.signal.throwIfAborted();
    }
  }
  ctx.llm.registerAdapter(['integration'], new OfflineAdapter());
  const id = 'session-aabbccdd-1111-4444-9999-000000000003';
  const handle = await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions: { provider: 'integration', model: 'offline' } });
  const workspace = await ctx.workspaceRegistry.create(cwd); await workspace.attachSession(id);
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'temporary offline test' }] }));
  let timer;
  try { await Promise.race([started.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native turn failed to start')), 3000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(handle.agent.status, 'running');
  await deleteSessionFromMenu(ctx, id);
  assert.equal(aborted, true); assert.equal(ctx.agents.get(id), undefined); assert.equal(ctx.sessions.get(id), undefined);
  assert.equal(workspace.sessionIds.includes(id), false); assert.deepEqual(listArchivedSessions(ctx), []);
});
