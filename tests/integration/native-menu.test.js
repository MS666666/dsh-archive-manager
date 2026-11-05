import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
const runtime = new URL('../../.compat-runtime/node_modules/', import.meta.url);
const nativeFile = new URL('@deepseek-ai/dsh-client-ui-context-menu/lib/client.js', runtime);

test('official 0.2.2-rc.1 menu resolves one native delete action and keeps legacy row hidden', { skip: !existsSync(nativeFile) }, async t => {
  const store = await import(new URL('@deepseek-ai/dsh-client-store/lib/index.js', runtime));
  const entries = []; const disposers = []; const requests = [];
  const jsx = (type, props, key) => ({ type, props, key });
  const react = { useSyncExternalStore: (subscribe, get) => get(), useState: v => [v, () => {}], useRef: v => ({ current: v }) };
  const ui = { MENU_TRANSITION_MS: { prepare: 0, dismiss: 0, replace: 0 }, MenuItemButton: 'item', Modal: 'modal', Button: 'button' };
  const sandbox = vm.createContext({
    window: { addEventListener() {}, removeEventListener() {} },
    document: { querySelector: () => ({}), addEventListener() {}, removeEventListener() {} },
    setTimeout, clearTimeout, AbortController, AbortSignal,
    fetch: async (url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ deleted: true }) }; },
  });
  const load = (source) => {
    let plugin;
    sandbox.window.__ModuleLoader__ = { load: definition => { plugin = definition.factory(name => {
      if (name === '@deepseek-ai/dsh-client-store') return store;
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return ui;
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      throw new Error(name);
    }); } };
    vm.runInContext(source, sandbox); return plugin;
  };
  const ctx = {
    locale: { register: () => () => {}, bind: () => key => key },
    shortcuts: { catalog: { getSnapshot: () => [] } },
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    provide: (name, value) => { ctx[name] = value; },
    slots: {
      provideRoot() {}, inject: (name, fn) => fn(),
      register: (spec, component) => { entries.push({ spec, component }); return () => {}; },
    },
    inject: (deps, fn) => fn(ctx),
  };
  load(readFileSync(nativeFile, 'utf8')).apply(ctx);
  load(readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')).apply(ctx);
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); });
  const target = { kind: 'session', value: { sessionId: 'session-aabbccdd', displayTitle: 'Native menu target' } };
  const resolution = ctx.contextMenus.resolve(target); await resolution.ready;
  const items = resolution.source.getSnapshot();
  assert.equal(items.length, 1); assert.equal(items[0].label, 'deleteSession');
  assert.equal(items[0].danger, true); assert.equal(items[0].afterContent, true);
  const legacy = entries.find(e => e.spec.name === 'sidebar.workspaces.session.menu.item');
  assert.equal(legacy.component({ useMenuOpenState: () => [true, () => {}], ...legacy.spec.inject() }), null);
  const overlay = entries.find(e => e.spec.id === 'archive-manager.delete-confirm');
  assert.equal(overlay.component(), null);
  resolution.select(items[0].id);
  const form = overlay.component();
  assert.equal(form.props.request.sessionId, target.value.sessionId);
  assert.equal(requests.length, 0);
  const modal = form.type(form.props);
  await modal.props.footer.props.children[1].props.onClick();
  assert.equal(requests.length, 1); assert.equal(requests[0].sessionId, target.value.sessionId);
  assert.equal(requests[0].archiveFirst, true); assert.equal(overlay.component(), null);
  const otherKind = ctx.contextMenus.resolve({ kind: 'workspace', value: { workspaceId: 'work' } });
  await otherKind.ready; assert.equal(otherKind.source.getSnapshot().length, 0); otherKind.dispose();
});
