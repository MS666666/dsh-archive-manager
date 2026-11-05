import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { listArchivedSessions, deleteArchivedSession, restoreArchivedSession, reconcileDeletedSessions, deleteSessionFromMenu } from '../lib/routes.js';

function fixture(t) {
  const home = mkdtempSync(join(process.cwd(), '.archive-rc5-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = 'session-abcd-1234';
  const dir = join(home, 'sessions', 'workspace', id);
  const cache = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(cache, '..'), { recursive: true });
  writeFileSync(cache, JSON.stringify({ record: { rows: { title: { val: 'rc.5 title' } }, identity: { createdAt: 123 } } }));
  let state = { archivedSessionIds: [id], pinnedSessionIds: [], workspaceIds: ['workspace'] };
  let members = [id, 'session-ffff'];
  let tail = Promise.resolve();
  const registry = {
    get archivedSessionIds() { return state.archivedSessionIds; },
    requireState: () => state,
    setState: async next => { state = next; },
    enqueueOperation: fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; },
    list: () => [{ get sessionIds() { return members; }, detachSession: async value => { members = members.filter(id => id !== value); } }],
    unarchiveSession: async value => registry.enqueueOperation(() => registry.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter(id => id !== value) })),
  };
  return { home, id, dir, cache, registry, members: () => members,
    host: { workspaceRegistry: registry, sessionPersistence: { root: join(home, 'sessions') } } };
}

test('rc.5 list uses live archive set and per-record titles without workspace.json', t => {
  const f = fixture(t);
  assert.deepEqual(listArchivedSessions(f.host), [{ sessionId: f.id, title: 'rc.5 title', createdAt: 123, onDisk: true }]);
});
test('restore uses public rc.5 method and is idempotent', async t => {
  const f = fixture(t);
  assert.deepEqual(await restoreArchivedSession(f.host, f.id), { restored: true });
  assert.deepEqual(await restoreArchivedSession(f.host, f.id), { restored: false });
  assert.ok(existsSync(f.dir));
});
test('delete removes disk, new cache and live accounting, preserving other members', async t => {
  const f = fixture(t);
  assert.deepEqual(await deleteArchivedSession(f.host, f.id), { deleted: true });
  assert.equal(existsSync(f.dir), false);
  assert.equal(existsSync(f.cache), false);
  assert.deepEqual(f.registry.archivedSessionIds, []);
  assert.deepEqual(f.members(), ['session-ffff']);
});
test('unsupported loaded-session lifecycle and invalid IDs are refused', async t => {
  const f = fixture(t);
  f.host.sessions = { get: () => ({}) };
  await assert.rejects(deleteArchivedSession(f.host, f.id), { status: 409 });
  await assert.rejects(deleteArchivedSession(f.host, '../outside'), { status: 400 });
  assert.ok(existsSync(f.dir));
});
test('restore queued before deletion prevents deletion', async t => {
  const f = fixture(t);
  await restoreArchivedSession(f.host, f.id);
  await assert.rejects(deleteArchivedSession(f.host, f.id), { status: 400 });
  assert.ok(existsSync(f.dir));
});
test('live cache failures keep archive marker for retry', async t => {
  const f = fixture(t);
  f.host.storageDomain = { get: () => ({ table: () => ({ delete: async () => { throw new Error('write failed'); } }) }) };
  await assert.rejects(deleteArchivedSession(f.host, f.id), /write failed/);
  assert.deepEqual(f.registry.archivedSessionIds, [f.id]);
  assert.ok(existsSync(f.dir));
});


test('missing log directory still permits clearing an orphan archive marker', async t => {
  const f = fixture(t);
  rmSync(f.dir, { recursive: true });
  assert.deepEqual(await deleteArchivedSession(f.host, f.id), { deleted: true });
  assert.deepEqual(listArchivedSessions(f.host), []);
});


test('deleted session cannot reappear after stale snapshot write or host restart', async t => {
  const f = fixture(t);
  f.registry.headers = new Map([[f.id, { id: f.id }]]);
  await deleteArchivedSession(f.host, f.id);
  assert.equal(f.registry.headers.has(f.id), false);
  // A subsequent host operation rewrites a stale global snapshot.
  await f.registry.setState({ ...f.registry.requireState(), archivedSessionIds: ['session-ffff', f.id] });
  assert.deepEqual(listArchivedSessions(f.host).map(row => row.sessionId), ['session-ffff']);
  await reconcileDeletedSessions(f.host);
  assert.deepEqual(f.registry.archivedSessionIds, ['session-ffff']);
  // Fresh context reads receipts from disk, not a process-local Set.
  const restarted = { ...f.host };
  await f.registry.setState({ ...f.registry.requireState(), archivedSessionIds: [f.id] });
  await reconcileDeletedSessions(restarted);
  assert.deepEqual(f.registry.archivedSessionIds, []);
});


function loadSession(f, { failClose = false } = {}) {
  const order = [];
  const session = { id: f.id };
  const writers = new Map();
  const agent = { id: f.id, session,
    cancel: cause => { assert.equal(cause.kind, 'disposed'); order.push('cancel'); },
    whenIdle: async () => { order.push('idle'); },
    scope: { dispose: async () => { order.push('scope'); } },
  };
  const writer = { close: async () => {
    assert.ok(existsSync(f.dir), 'log must survive until writer has closed');
    order.push('close');
    if (failClose) throw new Error('flush failed');
    writers.delete(f.id);
  } };
  writers.set(f.id, writer);
  const makeStore = (value, field) => {
    const store = new Map([[f.id, { [field]: value }]]);
    return { store, get: id => store.get(id)?.[field], detachEntered: entry => {
      assert.equal(writers.has(f.id), false);
      assert.equal(entry[field], value);
      order.push(field + '-removed'); store.delete(f.id);
    } };
  };
  f.host.agents = makeStore(agent, 'agent');
  f.host.sessions = makeStore(session, 'session');
  f.host.sessionPersistence.tracker = { writers };
  f.host.emit = (event, id) => {
    assert.equal(event, 'api-session/removed'); assert.equal(id, f.id);
    assert.equal(existsSync(f.dir), false);
    assert.deepEqual(f.members(), ['session-ffff']);
    order.push('sidebar-removed');
  };
  return order;
}

test('archive then delete releases a loaded rc.5 session and removes the sidebar row', async t => {
  const f = fixture(t);
  const order = loadSession(f);
  assert.deepEqual(await deleteArchivedSession(f.host, f.id), { deleted: true });
  assert.deepEqual(order, ['cancel', 'idle', 'scope', 'close', 'agent-removed', 'session-removed', 'sidebar-removed']);
  assert.equal(f.host.sessions.get(f.id), undefined);
  assert.equal(f.host.agents.get(f.id), undefined);
  assert.deepEqual(listArchivedSessions(f.host), []);
});

test('writer flush failure never removes files or archive membership', async t => {
  const f = fixture(t);
  const order = loadSession(f, { failClose: true });
  await assert.rejects(deleteArchivedSession(f.host, f.id), /flush failed/);
  assert.ok(existsSync(f.dir));
  assert.ok(f.registry.archivedSessionIds.includes(f.id));
  assert.equal(order.includes('sidebar-removed'), false);
});

test('cold archived deletion also notifies the native sidebar', async t => {
  const f = fixture(t); const events = [];
  f.host.emit = (...args) => events.push(args);
  await deleteArchivedSession(f.host, f.id);
  assert.deepEqual(events, [['api-session/removed', f.id]]);
});


test('menu deletion archives a normal session with stopActivity before deleting', async t => {
  const f = fixture(t);
  await restoreArchivedSession(f.host, f.id);
  const calls = [];
  f.registry.archiveSession = async (id, options) => {
    calls.push([id, options]);
    await f.registry.setState({ ...f.registry.requireState(), archivedSessionIds: [id] });
  };
  await deleteSessionFromMenu(f.host, f.id);
  assert.deepEqual(calls, [[f.id, { stopActivity: true }]]);
  assert.equal(existsSync(f.dir), false);
  assert.deepEqual(f.members(), ['session-ffff']);
  assert.deepEqual(await deleteSessionFromMenu(f.host, f.id), { deleted: true });
  assert.equal(calls.length, 1);
});

test('invalid menu target and failed archive cannot delete log files', async t => {
  const f = fixture(t);
  f.registry.archiveSession = async () => { throw new Error('archive failed'); };
  await assert.rejects(deleteSessionFromMenu(f.host, '../outside'), { status: 400 });
  await assert.rejects(deleteSessionFromMenu(f.host, f.id), /archive failed/);
  assert.ok(existsSync(f.dir));
});


for (const announcement of ['pending', 'dispatching', 'failed']) {
  test(`0.2.2 session announcement ${announcement} is not detached`, async t => {
    const f = fixture(t);
    loadSession(f);
    const entry = f.host.sessions.store.get(f.id);
    entry.announcement = announcement;
    await assert.rejects(deleteArchivedSession(f.host, f.id), { status: 409 });
    assert.ok(existsSync(f.dir));
    assert.ok(f.host.sessions.get(f.id));
    assert.ok(f.registry.archivedSessionIds.includes(f.id));
  });
}
