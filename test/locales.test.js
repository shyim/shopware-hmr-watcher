import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dateFnsLocaleContext } from '../src/locales.js';

test('date-fns contexts include public locales without index or CDN bundles', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rspack-locales-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'package.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      exports: {
        './locale': { import: { default: './locale.js' } },
        './locale/de': { import: { default: './locale/de.js' } },
        './locale/en-US': { import: { default: './locale/en-US.js' } },
        './add': { import: { default: './add.js' } },
      },
    }),
  );
  const check = () => {
    const context = dateFnsLocaleContext(file);
    assert.equal(context.directory, path.join(directory, 'locale'));
    for (const request of ['./de', './en-US', './de.js', './en-US.js'])
      assert.equal(context.pattern.test(request), true);
    for (const request of ['./index', './index.js', './cdn', './cdn.js', './_lib', './unknown'])
      assert.equal(context.pattern.test(request), false);
  };
  check();
  fs.writeFileSync(file, '{}');
  for (const name of ['de', 'en-US', '_lib']) {
    fs.mkdirSync(path.join(directory, 'locale', name), { recursive: true });
    fs.writeFileSync(path.join(directory, 'locale', name, 'index.js'), '');
  }
  for (const name of ['index.js', 'cdn.js'])
    fs.writeFileSync(path.join(directory, 'locale', name), '');
  check();
});
