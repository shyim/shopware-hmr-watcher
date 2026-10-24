import test from 'node:test';
import assert from 'node:assert/strict';

async function runtime(t) {
  delete globalThis[Symbol.for('shopware-admin-rspack.legacy-hmr')];
  t.after(() => {
    delete globalThis.Shopware;
    delete globalThis.__VUE_HMR_RUNTIME__;
    delete globalThis[Symbol.for('shopware-admin-rspack.legacy-hmr')];
  });
  return import(`../src/runtime/legacy-hmr.js?test=${Math.random()}`);
}

test('Twig file identities isolate identical text and bound history over repeated edits', async (t) => {
  const { templateSource, currentTemplate, registerLegacyComponent, updateTemplate } =
    await runtime(t);
  const original = templateSource('a', 'original');
  const other = templateSource('b', 'original');
  const override = templateSource('c', 'override');
  const registry = new Map([
    ['base', { raw: original, overrides: [{ raw: override }] }],
    ['other', { raw: other, overrides: [] }],
    ['child', { raw: 'child-template', extend: 'base', overrides: [] }],
  ]);
  const renders = [];
  globalThis.__VUE_HMR_RUNTIME__ = {
    createRecord() {},
    rerender(id, render) {
      renders.push([id, render]);
    },
  };
  const factory = {
    getTemplateRegistry: () => registry,
    clearTwigCache() {},
    getNormalizedTemplateRegistry: () => new Map(),
    getRenderedTemplate: (name) =>
      `${name}:${registry.get('base').raw}:${registry.get('base').overrides[0].raw}`,
  };
  globalThis.Shopware = {
    Application: { getContainer: () => ({ template: factory }) },
    Vue: {
      compile: (template) => {
        if (template.includes('invalid')) throw new Error('Invalid template');
        return template;
      },
    },
  };
  const native = { __hmrId: 'vue-loader-record', render() {} };
  registerLegacyComponent('native-sfc', native, {});
  assert.equal(native.__hmrId, 'vue-loader-record');
  for (const name of ['base', 'other', 'child']) registerLegacyComponent(name, {}, {});
  for (let edit = 0; edit < 100; edit++) updateTemplate('a', `edit ${edit}`);
  assert.deepEqual(
    [...new Set(renders.map(([id]) => id))],
    ['shopware-legacy:base', 'shopware-legacy:child'],
  );
  assert.equal(registry.get('other').raw, other);
  assert.equal(currentTemplate(original), templateSource('a', 'edit 99'));
  assert.equal(globalThis[Symbol.for('shopware-admin-rspack.legacy-hmr')].templates.size, 3);
  updateTemplate('a', 'original');
  assert.equal(currentTemplate(original), original);
  const messages = [];
  t.mock.method(console, 'error', (...args) => messages.push(args));
  const count = renders.length;
  updateTemplate('a', 'invalid');
  assert.equal(renders.length, count);
  assert.equal(registry.get('base').raw, original);
  assert.equal(currentTemplate(original), original);
  assert.equal(messages.length, 1);
  updateTemplate('a', 'recovered');
  assert.equal(registry.get('base').raw, templateSource('a', 'recovered'));
  updateTemplate('c', 'new-override');
  assert.equal(registry.get('base').overrides[0].raw, templateSource('c', 'new-override'));
});

// Models saves arriving while Shopware is still resolving an asynchronous config.
test('component updates serialize lazy resolution and never apply an older save last', async (t) => {
  const { componentModule, componentConfig, registerLegacyComponent, applyComponentUpdate } =
    await runtime(t);
  const renders = [];
  const factory = {
    getTemplateRegistry: () => new Map(),
    clearTwigCache() {},
    getNormalizedTemplateRegistry: () => new Map(),
  };
  globalThis.Shopware = { Application: { getContainer: () => ({ template: factory }) } };
  globalThis.__VUE_HMR_RUNTIME__ = {
    createRecord() {},
    reload: (id, config) => renders.push(config.value),
  };
  const next = (previous, value) => {
    const scope = componentModule({
      data: previous && { components: previous },
      accept() {},
      dispose() {},
    });
    componentConfig(scope, { value });
    return scope;
  };
  let firstResolve;
  let latest;
  let calls = 0;
  const adapter = {
    resolvedComponentConfigs: new Map(),
    componentResolver: async () => {
      const value = latest.defaultConfig.value;
      if (!calls++)
        await new Promise((resolve) => {
          firstResolve = resolve;
        });
      return { value };
    },
  };
  const initial = next(null, 0);
  registerLegacyComponent('example', initial.defaultConfig, adapter);
  latest = next(initial, 1);
  applyComponentUpdate(latest);
  await new Promise((resolve) => setImmediate(resolve));
  latest = next(latest, 2);
  applyComponentUpdate(latest);
  firstResolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(renders, [2]);
  const messages = [];
  t.mock.method(console, 'error', (...args) => messages.push(args));
  adapter.componentResolver = async () => {
    throw new Error('Broken component');
  };
  latest = next(latest, 3);
  applyComponentUpdate(latest);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(renders, [2]);
  assert.equal(messages.length, 1);
  adapter.componentResolver = async () => ({ value: latest.defaultConfig.value });
  latest = next(latest, 4);
  applyComponentUpdate(latest);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(renders, [2, 4]);
  assert.equal(latest.previous, null);
  assert.equal(latest.hot.data.components, undefined);
  assert.equal(globalThis[Symbol.for('shopware-admin-rspack.legacy-hmr')].sources.size, 1);
});
