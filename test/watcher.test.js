import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import puppeteer from 'puppeteer-core';
import { startWatcher } from '../src/server.js';

function nextBuild(compiler) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for a rebuild')), 20000);
    const listener = (stats) => {
      clearTimeout(timer);
      if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
      else setTimeout(() => resolve(stats), 25);
    };
    compiler.hooks.done.tap('test-next-build', listener);
  });
}

test(
  'serves multiple compilers, proxies the API and rebuilds an extension independently',
  { timeout: 60000 },
  async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rspack-watch-')));
    const admin = path.join(root, 'admin');
    const source = path.join(root, 'extension/src');
    fs.mkdirSync(path.join(admin, 'src'), { recursive: true });
    fs.mkdirSync(path.join(admin, 'static'), { recursive: true });
    fs.mkdirSync(path.join(source, 'modules'), { recursive: true });
    fs.symlinkSync(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(admin, 'node_modules'),
      'dir',
    );
    fs.writeFileSync(path.join(admin, 'package.json'), '{}');
    fs.writeFileSync(
      path.join(admin, 'index.html'),
      '<html><body><div id="app"></div><div id="extension"></div><script type="module" src="/src/index.ts"></script></body></html>',
    );
    fs.writeFileSync(
      path.join(admin, 'src/index.ts'),
      'import * as Vue from "vue"; import App from "./App.vue"; window.Shopware = { Vue }; Vue.createApp(App).mount("#app");',
    );
    const component = (label) =>
      `<script setup>import { ref } from 'vue'; const count = ref(0);</script><template><button @click="count++">${label} {{ count }}</button></template>`;
    fs.writeFileSync(path.join(admin, 'src/App.vue'), component('admin-before'));
    fs.writeFileSync(path.join(source, 'App.vue'), component('extension-before'));
    fs.writeFileSync(path.join(source, 'style.scss'), '#extension { color: rgb(255, 0, 0); }');
    fs.writeFileSync(path.join(admin, 'static/example.txt'), 'source-static-asset');
    const entry = path.join(source, 'main.ts');
    fs.writeFileSync(
      entry,
      'import * as Vue from "vue"; import App from "./App.vue"; import "./style.scss"; window.extensionVue = Vue; window.extensionValue = "before-edit"; Vue.createApp(App).mount("#extension");',
    );
    const backend = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ path: req.url }));
    });
    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');
    t.after(() => new Promise((resolve) => backend.close(resolve)));
    const project = {
      root,
      admin,
      env: {},
      extensions: [{ name: 'Example', technicalName: 'example', source, entry, folder: 'example' }],
    };
    const watcher = await startWatcher(project, {
      host: '127.0.0.1',
      port: 0,
      url: `http://127.0.0.1:${backend.address().port}`,
    });
    t.after(() => watcher.stop());
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await nextBuild(watcher.compiler);
    assert.equal(watcher.compiler.compilers.length, 2);
    const base = `http://127.0.0.1:${watcher.server.server.address().port}`;
    assert.deepEqual(await (await fetch(`${base}/api/test`)).json(), { path: '/api/test' });
    assert.equal(
      await (
        await fetch(`${base}/bundles/administration/administration/static/example.txt`)
      ).text(),
      'source-static-asset',
    );
    const manifest = await (await fetch(`${base}/sw-plugin-dev.json`)).json();
    const extensionUrl = base + manifest.example.js;
    const originalAdmin = await (await fetch(`${base}/administration.js`)).text();
    const extension = await (await fetch(extensionUrl)).text();
    assert.match(extension, /window\["Shopware"\]\["Vue"\]|window\.Shopware\.Vue/);
    assert.match(extension, /before-edit/);
    const chrome =
      process.env.CHROME_BIN ||
      [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
      ].find((file) => fs.existsSync(file));
    await t.test(
      'Vue and Sass HMR preserve state across both compilers without a page reload',
      { skip: !chrome },
      async () => {
        const browser = await puppeteer.launch({
          executablePath: chrome,
          headless: true,
          args: ['--no-sandbox'],
        });
        try {
          const page = await browser.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(base, { waitUntil: 'networkidle0' });
          await page.evaluate(async (url) => {
            await import(url);
            window.hmrMarker = 'same-page';
          }, extensionUrl);
          await page.waitForSelector('#extension button');
          assert.equal(
            await page.evaluate(() => window.extensionVue.ref === window.Shopware.Vue.ref),
            true,
          );
          await page.click('#app button');
          await page.click('#extension button');
          for (const [file, label, selector] of [
            [path.join(admin, 'src/App.vue'), 'admin-after', '#app button'],
            [path.join(source, 'App.vue'), 'extension-after', '#extension button'],
          ]) {
            const started = performance.now();
            fs.writeFileSync(file, component(label));
            await page.waitForFunction(
              (selector, text) => document.querySelector(selector)?.textContent === text,
              { timeout: 10000 },
              selector,
              `${label} 1`,
            );
            t.diagnostic(`${label} HMR applied in ${Math.round(performance.now() - started)} ms`);
            assert.equal(await page.evaluate(() => window.hmrMarker), 'same-page');
          }
          fs.writeFileSync(
            path.join(source, 'style.scss'),
            '#extension { color: rgb(0, 0, 255); }',
          );
          await page.waitForFunction(
            () => getComputedStyle(document.querySelector('#extension')).color === 'rgb(0, 0, 255)',
            { timeout: 10000 },
          );
          assert.equal(await page.evaluate(() => window.hmrMarker), 'same-page');
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
        }
      },
    );
    const adminBeforeExtensionEdit = await (await fetch(`${base}/administration.js`)).text();
    const globModule = path.join(source, 'glob.ts');
    fs.writeFileSync(globModule, 'export default {};');
    const build = nextBuild(watcher.compiler);
    fs.writeFileSync(
      entry,
      'import modules from "./glob"; window.discovered = modules; window.extensionValue = "after-edit";',
    );
    await build;
    assert.match(await (await fetch(extensionUrl)).text(), /after-edit/);
    assert.equal(await (await fetch(`${base}/administration.js`)).text(), adminBeforeExtensionEdit);
    assert.ok(originalAdmin.length > 0);
    // An entry with no source-filter keywords must still watch auto-discovered overrides.
    const override = path.join(source, 'Example.override.vue');
    let pending = nextBuild(watcher.compiler);
    fs.writeFileSync(override, '<template><p>auto-discovered-override</p></template>');
    await pending;
    const withOverride = await (await fetch(extensionUrl)).text();
    assert.match(withOverride, /auto-discovered-override/);
    assert.match(withOverride, /registerOverrideComponent/);
    pending = nextBuild(watcher.compiler);
    fs.unlinkSync(override);
    await pending;
    assert.doesNotMatch(await (await fetch(extensionUrl)).text(), /auto-discovered-override/);
    pending = nextBuild(watcher.compiler);
    fs.writeFileSync(
      globModule,
      `export default import.meta.glob('./modules/**/*.ts', { eager: true });`,
    );
    await pending;
    const discovered = path.join(source, 'modules/new.ts');
    pending = nextBuild(watcher.compiler);
    fs.writeFileSync(discovered, 'export const value = "new-glob-module";');
    await pending;
    assert.match(await (await fetch(extensionUrl)).text(), /new-glob-module/);
    pending = nextBuild(watcher.compiler);
    fs.unlinkSync(discovered);
    await pending;
    assert.ok(!(await (await fetch(extensionUrl)).text()).includes('new-glob-module'));
    pending = nextBuild(watcher.compiler);
    fs.writeFileSync(discovered, 'export const value = "recreated-glob-module";');
    await pending;
    assert.match(await (await fetch(extensionUrl)).text(), /recreated-glob-module/);
    pending = nextBuild(watcher.compiler);
    fs.mkdirSync(path.join(source, 'modules/nested'));
    fs.writeFileSync(
      path.join(source, 'modules/nested/new.ts'),
      'export const value = "nested-glob-module";',
    );
    await pending;
    assert.match(await (await fetch(extensionUrl)).text(), /nested-glob-module/);
    pending = nextBuild(watcher.compiler);
    fs.writeFileSync(globModule, 'export default { value: "no-longer-a-glob" };');
    await pending;
    const withoutGlob = await (await fetch(extensionUrl)).text();
    assert.match(withoutGlob, /no-longer-a-glob/);
    assert.doesNotMatch(withoutGlob, /nested-glob-module|recreated-glob-module/);

    assert.equal(
      fs.existsSync(path.join(root, 'var/cache/shopware-admin-rspack')),
      false,
      'bundles stay in memory',
    );
  },
);
