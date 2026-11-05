import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('native menu opens independent confirmation; cancel is read-only; confirm sends exact target', async () => {
  const entries = []; const requests = []; let plugin;
  const jsx = (type, props, key) => ({ type, props, key });
  const primitives = { MenuItemButton: 'native-menu-item', Modal: 'native-modal', Button: 'native-button' };
  const fakeReact = {
    useSyncExternalStore: (subscribe, get) => get(),
    useState: value => [value, () => {}],
    useRef: value => ({ current: value }),
  };
  vm.runInNewContext(readFileSync(new URL('../client/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: definition => {
      plugin = definition.factory(name => {
        if (name === 'react') return fakeReact;
        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
        throw new Error(name);
      });
    } } },
    fetch: async (url, options) => { requests.push({ url, ...JSON.parse(options.body) }); return { ok: true, json: async () => ({ ok: true, deleted: true }) }; },
  });
  const ctx = {
    effect: fn => fn(),
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (name, fn) => fn(), register: (spec, component) => { entries.push({ spec, component }); return () => {}; } },
  };
  plugin.apply(ctx);
  const menu = entries.find(e => e.spec.name === 'sidebar.workspaces.session.menu.item');
  const overlay = entries.find(e => e.spec.name === 'shell.overlay');
  assert.equal(menu.spec.order, 500);
  assert.equal(overlay.component(), null);
  let open = true;
  const menuItem = menu.component({ sessionId: 'session-abcd', displayTitle: 'Exact target', useMenuOpenState: () => [open, next => { open = next; }], ...menu.spec.inject() });
  assert.equal(menuItem.type, 'native-menu-item');
  menuItem.props.onSelect();
  assert.equal(open, false);
  assert.equal(requests.length, 0);
  let form = overlay.component();
  assert.equal(form.props.request.title, 'Exact target');
  let modal = form.type(form.props);
  assert.equal(modal.type, 'native-modal');
  modal.props.onClose();
  assert.equal(overlay.component(), null);
  assert.equal(requests.length, 0);
  menuItem.props.onSelect();
  form = overlay.component(); modal = form.type(form.props);
  await modal.props.footer.props.children[1].props.onClick();
  assert.deepEqual(requests, [{ url: '/dsh-archive-manager-plus/delete', sessionId: 'session-abcd', archiveFirst: true }]);
  assert.equal(overlay.component(), null);
});
