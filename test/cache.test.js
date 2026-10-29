import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('persistent cache restores builds and invalidates Sass dependencies and configuration', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rspack-cache-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const admin = path.join(root, 'admin');
  fs.mkdirSync(path.join(admin, 'src'), { recursive: true });
  fs.symlinkSync(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(admin, 'node_modules'),
    'dir',
  );
  fs.writeFileSync(path.join(admin, 'package.json'), '{}');
  fs.writeFileSync(path.join(admin, 'index.html'), '<html><body></body></html>');
  fs.writeFileSync(path.join(admin, 'src/index.ts'), 'import "./style.scss";');
  fs.writeFileSync(
    path.join(admin, 'src/style.scss'),
    '@use "./colors"; .cache-probe { color: colors.$color; }',
  );
  const partial = path.join(admin, 'src/_colors.scss');
  fs.writeFileSync(partial, '$color: red;');
  const calls = path.join(root, 'loader-calls');
  const probe = path.join(root, 'probe.cjs');
  fs.writeFileSync(
    probe,
    `module.exports = function(source) {
      require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'run\\n');
      return source;
    };`,
  );
  const project = { root, admin, env: {}, extensions: [] };
  async function build(options = {}) {
    // Restart the process as the CLI does: VueLoaderPlugin's generated loader
    // identifiers otherwise change between compiler instances in one process.
    await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { rspack } from '@rspack/core';
      import { createConfigurations } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
      const compiler = rspack(createConfigurations(${JSON.stringify(project)}, {
        ...${JSON.stringify(options)},
        configure(config) {
          config.module.rules.push({ test: /\\.scss$/, enforce: 'pre', use: [${JSON.stringify(probe)}] });
        },
      }));
      try {
        const stats = await new Promise((resolve, reject) => {
          compiler.run((error, stats) => error ? reject(error) : resolve(stats));
        });
        if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
      } finally {
        await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
      }`,
      ],
      { cwd: fileURLToPath(new URL('..', import.meta.url)) },
    );
    return {
      calls: fs.readFileSync(calls, 'utf8').length,
      output: fs.readFileSync(
        path.join(root, 'var/cache/shopware-admin-rspack/administration/administration.js'),
        'utf8',
      ),
    };
  }

  const cold = await build();
  assert.match(cold.output, /color: red/);
  assert.match(cold.output, /^\/\/# sourceMappingURL=/m);
  const warm = await build();
  assert.match(warm.output, /color: red/);
  assert.equal(warm.calls, cold.calls, 'a new process restores cached loader results');

  fs.writeFileSync(partial, '$color: blue;');
  const edited = await build();
  assert.match(edited.output, /color: blue/);
  assert.doesNotMatch(edited.output, /color: red/);

  const configured = await build({ sourcemap: false });
  assert.match(configured.output, /color: blue/);
  assert.doesNotMatch(configured.output, /^\/\/# sourceMappingURL=/m);

  const memoryOnly = await build({ cache: false });
  assert.match(memoryOnly.output, /color: blue/);
  assert.ok(memoryOnly.calls > configured.calls, '--no-cache does not restore the disk cache');
});
