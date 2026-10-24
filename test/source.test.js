import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const loader = require('../src/loaders/source.cjs');

function transform(t, code, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rspack-glob-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'index.ts'), code);
  for (const [name, value] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
  }
  const directories = [];
  let output;
  loader.call(
    {
      resourcePath: path.join(root, 'index.ts'),
      getOptions: () => ({ admin: root }),
      addDependency() {},
      addContextDependency(dir) {
        directories.push(dir);
      },
      callback(error, code) {
        assert.equal(error, null);
        output = code;
      },
    },
    code,
  );
  return { output, directories, root };
}

test('eager TypeScript globs exclude the importer, tests and negative patterns', (t) => {
  const { output, directories, root } = transform(
    t,
    `export default import.meta.glob<unknown>(['./**/!(*.spec).{j,t}s', '!./excluded.ts'], { eager: true, import: 'default' });`,
    { 'a.ts': 'export default 1;', 'a.spec.ts': '', 'excluded.ts': '' },
  );
  assert.match(output, /"\.\/a.ts": __swGlob0\["default"\]/);
  assert.doesNotMatch(output, /"\.\/index.ts":|"\.\/excluded.ts":|"\.\/a.spec.ts":/);
  assert.ok(directories.includes(root));
});

test('lazy glob imports keep raw queries and named export selection', (t) => {
  const { output } = transform(
    t,
    `export default import.meta.glob('./*.html', { query: '?raw', import: 'default' });`,
    { 'a.html': '<p>hello</p>' },
  );
  assert.match(output, /a.html\?raw/);
  assert.match(output, /\(\) => import\(.+\)\.then\(m => m\["default"\]\)/);
});

test('virtual imports distinguish extension and host consumers', (t) => {
  const { output } = transform(t, `import { createId } from 'shopware:utils';`);
  assert.match(output, /virtual.cjs/);
  assert.match(output, /shopware:utils/);
});

test('leaves ordinary shopware strings and untouched JavaScript unchanged', (t) => {
  const source = `const label = 'shopware:utils'; export { label };`;
  assert.equal(transform(t, source).output, source);
  assert.equal(transform(t, 'export default 42;').output, 'export default 42;');
});

test('component boundaries support typed configurations and leave routing modules alone', (t) => {
  const component = `const { Component } = Shopware;
    export default Component.wrapComponentConfig({
      data() { return { count: <number>1 }; },
    });`;
  const { output } = transform(t, component);
  assert.match(output, /import\.meta\.webpackHot/);
  assert.match(output, /__swConfig\(__swComponentScope, Component\.wrapComponentConfig/);

  for (const source of [
    `const { Component, Module } = Shopware; Component.register('example', {}); Module.register('module', {});`,
    `Shopware.Component.register('example', () => import('./example'));`,
    `const Component = unrelatedFactory; Component.register('example', {});`,
    `Shopware.Component.register('example', {}); window.addEventListener('click', listener);`,
    `const { Component: C, Module: M } = Shopware; C.register('example', {}); M.register('module', {});`,
    `Shopware.Component.register('example', {}); function later() { Shopware.Component.override('example', {}); }`,
  ]) {
    assert.equal(transform(t, source).output, source);
  }
});

test('override and mixin definitions support aliases and default exports', (t) => {
  assert.match(
    transform(t, `const { Component: C } = Shopware; C.override('example', {});`).output,
    /__swRegister\(__swComponentScope, C, "override"/,
  );
  assert.match(
    transform(t, `const { Mixin: M } = Shopware; export default M.register('example', {});`).output,
    /export default __swMixin\(__swComponentScope, M/,
  );
});
