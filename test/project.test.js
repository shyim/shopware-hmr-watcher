import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverProject, extensionManifest } from '../src/project.js';

function fixture(t, vendor = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rspack-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const admin = path.join(
    root,
    vendor ? 'vendor/shopware/administration' : 'src/Administration',
    'Resources/app/administration',
  );
  fs.mkdirSync(path.join(admin, 'src'), { recursive: true });
  fs.mkdirSync(path.join(admin, 'node_modules/vue'), { recursive: true });
  fs.writeFileSync(path.join(admin, 'src/index.ts'), '');
  const base = path.join(root, 'custom/plugins/Example');
  fs.mkdirSync(path.join(base, 'src'), { recursive: true });
  fs.writeFileSync(path.join(base, 'src/main.ts'), '');
  fs.mkdirSync(path.join(root, 'var'));
  fs.writeFileSync(
    path.join(root, 'var/plugins.json'),
    JSON.stringify({
      ExampleBundle: {
        basePath: 'custom/plugins/Example',
        technicalName: 'example',
        administration: { path: 'src', entryFilePath: 'src/main.ts' },
      },
    }),
  );
  return { root, admin };
}

for (const vendor of [false, true])
  test(`discovers ${vendor ? 'Composer' : 'source'} installations and extension entries`, (t) => {
    const { root, admin } = fixture(t, vendor);
    const result = discoverProject(root, {});
    assert.equal(result.admin, fs.realpathSync(admin));
    assert.equal(result.extensions[0].folder, 'example');
    assert.deepEqual(extensionManifest(result.extensions), {
      metadata: 'shopware',
      example: { js: '/_internal_ext/example/example.js' },
    });
  });

test('loads the target environment with explicit overrides and SKIP flags', (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, '.env'), 'APP_URL=http://base.test\nHOST_NAME=local.test\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'APP_URL=https://${HOST_NAME}\n');
  assert.equal(discoverProject(root, {}).env.APP_URL, 'https://local.test');
  const result = discoverProject(root, { APP_URL: 'https://override.test', SKIP_EXAMPLE: '1' });
  assert.equal(result.env.APP_URL, 'https://override.test');
  assert.equal(result.extensions.length, 0);
});

test('reports stale manifests with missing entry files', (t) => {
  const { root } = fixture(t);
  fs.unlinkSync(path.join(root, 'custom/plugins/Example/src/main.ts'));
  assert.throws(() => discoverProject(root, {}), /Missing entry.*bundle:dump/);
});
