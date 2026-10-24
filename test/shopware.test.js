import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { discoverProject } from '../src/project.js';
import { startWatcher } from '../src/server.js';

const root = process.env.SHOPWARE_ROOT;
const chrome =
  process.env.CHROME_BIN ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find((file) => fs.existsSync(file));

test(
  'real Shopware supports Twig and component script HMR without reloading the page',
  { skip: !root || !chrome, timeout: 120000 },
  async (t) => {
    const project = discoverProject(root);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rspack-real-hmr-'));
    const original = fs.readFileSync(
      path.join(project.admin, 'src/module/sw-login/view/sw-login-login/sw-login-login.html.twig'),
      'utf8',
    );
    const file = path.join(temp, 'sw-login-login.html.twig');
    fs.writeFileSync(file, original);
    const extensionSource = path.join(temp, 'extension');
    fs.mkdirSync(extensionSource);
    const extensionTemplate = path.join(extensionSource, 'template.twig');
    const extensionMarkup = (label) =>
      `{% block rspack_probe %}<button id="extension-twig-counter" @click="increment">${label} {{ display }}</button>{% endblock %}`;
    fs.writeFileSync(extensionTemplate, extensionMarkup('before'));
    const lazyFile = path.join(extensionSource, 'lazy.ts');
    const lazyScript = (value) => `
      const { Component } = Shopware;
      export default Component.wrapComponentConfig({
        template: '<button id="lazy-component">{{ value }}</button>',
        data() { return { value: <number>${value} }; },
      });
    `;
    fs.writeFileSync(lazyFile, lazyScript(10));
    fs.writeFileSync(
      path.join(extensionSource, 'registrations.js'),
      `
      Shopware.Component.register('rspack-lazy-probe', () => import('./lazy'));
      Shopware.Component.extend('rspack-child-probe', 'rspack-twig-probe', {
        template: '{% block rspack_probe %}<button id="child-counter" @click="increment">{{ display }}</button>{% endblock %}',
      });
    `,
    );
    const extensionEntry = path.join(extensionSource, 'main.js');
    const extensionScript = (initial = 0, step = 1, factor = 1) => `
      import template from './template.twig';
      import './registrations';
      import './reliability';
      import './sfc-registration';
      import virtualCallStack from 'src/app/plugin/virtual-call-stack.plugin';
      window.rspackProbePlugin = virtualCallStack;
      window.rspackLoadLocale = (locale) => import(\`date-fns/locale/\${locale}\`);
      Shopware.Component.register('rspack-twig-probe', {
        template,
        data() { return { count: ${initial} }; },
        methods: { increment() { this.count += ${step}; } },
        computed: { display() { return this.count * ${factor}; } },
      });
    `;
    fs.writeFileSync(extensionEntry, extensionScript());
    // Separate files deliberately start with identical contents.
    const twins = ['a', 'b'].map((name) => path.join(extensionSource, `${name}.twig`));
    const twinMarkup = (label) =>
      `<button class="twin" @click="count++">${label} {{ count }}</button>`;
    for (const twin of twins) fs.writeFileSync(twin, twinMarkup('same'));
    const mixinFile = path.join(extensionSource, 'mixin.ts');
    const mixinScript = (step) => `
      import { defineComponent } from 'vue';
      const { Mixin: M } = Shopware;
      export default M.register('rspack-reliability', defineComponent({
        data() { return { count: 0 }; },
        computed: { mixinLabel() { return 'M${step}'; } },
        methods: { increment() { this.count += ${step}; } },
        mounted() { window.addEventListener('hmr-probe', this.increment); },
        beforeUnmount() { window.removeEventListener('hmr-probe', this.increment); },
      }));
    `;
    fs.writeFileSync(mixinFile, mixinScript(1));
    const sfcFile = path.join(extensionSource, 'MixinComponent.vue');
    const sfcScript = (
      label,
    ) => `<template><button id="sfc-mixin" @click="increment">${label} {{ count }} {{ mixinLabel }}</button></template>
      <script setup>import mixin from './mixin'; defineOptions({ mixins: [mixin] }); swDefinePublic({});</script>`;
    fs.writeFileSync(sfcFile, sfcScript('SFC'));
    fs.writeFileSync(
      path.join(extensionSource, 'sfc-registration.js'),
      `Shopware.Component.register('rspack-sfc-mixin', () => import('./MixinComponent.vue'));`,
    );
    const overrideTemplate = path.join(extensionSource, 'override.twig');
    const overrideMarkup = (label) =>
      `{% block reliability %}<button class="override-counter" @click="increment">${label} {{ describe }} {{ count }} {{ mixinLabel }}</button>{% endblock %}`;
    fs.writeFileSync(overrideTemplate, overrideMarkup('OVERRIDE'));
    const overrideFile = path.join(extensionSource, 'override.js');
    const overrideScript = (value, template = true, priority = 0) => `
      import template from './override.twig';
      Shopware.Component.override('rspack-override-probe', {
        ${template ? 'template,' : ''}
        computed: { describe() { return this.$super('describe') + ' A${value}'; } },
      }, ${priority});
    `;
    fs.writeFileSync(overrideFile, overrideScript(0));
    fs.writeFileSync(
      path.join(extensionSource, 'reliability.js'),
      `
      import a from './a.twig';
      import b from './b.twig';
      import mixin from './mixin';
      import './override';
      Shopware.Component.register('rspack-twin-a', { template: a, data() { return { count: 0 }; } });
      Shopware.Component.register('rspack-twin-b', { template: b, data() { return { count: 0 }; } });
      Shopware.Component.register('rspack-override-probe', {
        template: ${JSON.stringify(overrideMarkup('BASE'))},
        mixins: [mixin],
        computed: { describe() { return 'base'; } },
      });
      Shopware.Component.extend('rspack-override-child', 'rspack-override-probe', {});
      Shopware.Component.register('rspack-named-mixin', {
        template: '<button id="named-mixin" @click="increment">{{ count }} {{ mixinLabel }}</button>',
        mixins: ['rspack-reliability'],
      });
    `,
    );
    const secondarySource = path.join(temp, 'secondary');
    fs.mkdirSync(secondarySource);
    fs.writeFileSync(path.join(secondarySource, 'package.json'), '{"type":"module"}');
    const secondaryEntry = path.join(secondarySource, 'main.js');
    fs.writeFileSync(
      secondaryEntry,
      `Shopware.Component.override('rspack-override-probe', () => import('./definition.js'));`,
    );
    const secondaryDefinition = path.join(secondarySource, 'definition.js');
    const secondaryTemplate = path.join(secondarySource, 'secondary.twig');
    fs.writeFileSync(secondaryTemplate, overrideMarkup('SECOND'));
    const secondaryScript = (value, withTemplate = false) => `
      import template from './secondary.twig';
      const { Component } = Shopware;
      export default Component.wrapComponentConfig({
        ${withTemplate ? 'template,' : ''}
        computed: { describe() { return this.$super('describe') + ' B${value}'; } },
      });
    `;
    fs.writeFileSync(secondaryDefinition, secondaryScript(0));
    project.extensions.push({
      name: 'TwigProbe',
      technicalName: 'twig-probe',
      folder: 'twigprobe',
      source: extensionSource,
      entry: extensionEntry,
    });
    project.extensions.push({
      name: 'SecondaryProbe',
      technicalName: 'secondary-probe',
      folder: 'secondaryprobe',
      source: secondarySource,
      entry: secondaryEntry,
    });
    const start = performance.now();
    const watcher = await startWatcher(project, {
      port: 0,
      cache: false,
      configure(config) {
        config.resolve.alias['./sw-login-login.html.twig$'] = file;
      },
    });
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: chrome,
      args: ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const consoleMessages = [];
      page.on('console', (message) => {
        consoleMessages.push(message.text());
        if (message.type() === 'error' && message.text().startsWith('[Shopware HMR]'))
          errors.push(message.text());
      });
      await page.goto(`http://localhost:${watcher.server.server.address().port}`, {
        waitUntil: 'networkidle0',
      });
      const input = 'input[name="sw-field--username"]';
      await page.waitForSelector(input);
      t.diagnostic(
        `Real Shopware login ready in ${Math.round(performance.now() - start)} ms (including browser launch)`,
      );
      await page.type(input, 'hmr-keeps-this');
      await page.evaluate(async () => {
        const { Shopware } = window;
        window.hmrMarker = 'same-page';
        const manifest = await (await fetch('/sw-plugin-dev.json')).json();
        for (const [name, entry] of Object.entries(manifest)) {
          if (name !== 'metadata') await import(entry.js);
        }
        for (const name of [
          'rspack-twig-probe',
          'rspack-lazy-probe',
          'rspack-child-probe',
          'rspack-twin-a',
          'rspack-twin-b',
          'rspack-override-probe',
          'rspack-override-child',
          'rspack-named-mixin',
          'rspack-sfc-mixin',
        ]) {
          const config = await Shopware.Application.view.componentResolver(name);
          const mount = document.createElement('div');
          mount.id = `mount-${name}`;
          document.body.appendChild(mount);
          try {
            Shopware.Vue.createApp(config).use(window.rspackProbePlugin).mount(mount);
          } catch (error) {
            throw new Error(`${name}: ${error.message}`, { cause: error });
          }
        }
      });
      assert.deepEqual(
        await page.evaluate(async () => {
          const codes = [];
          for (const name of ['de', 'en-US']) {
            const module = await window.rspackLoadLocale(name);
            codes.push(module[name.replace('-', '')].code);
          }
          try {
            await window.rspackLoadLocale('cdn');
            codes.push('unexpected-cdn');
          } catch {
            /* not a locale */
          }
          return codes;
        }),
        ['de', 'en-US'],
      );
      await page.click('#extension-twig-counter');
      await page.waitForSelector('#child-counter');
      for (const updated of [true, false]) {
        const started = performance.now();
        fs.writeFileSync(
          file,
          updated ? '<div id="hmr-proof">Twig HMR works</div>\n' + original : original,
        );
        await page.waitForFunction(
          (updated) => Boolean(document.querySelector('#hmr-proof')) === updated,
          { timeout: 10000 },
          updated,
        );
        t.diagnostic(
          `Twig ${updated ? 'edit' : 'undo'} HMR applied in ${Math.round(performance.now() - started)} ms`,
        );
        assert.equal(await page.evaluate(() => window.hmrMarker), 'same-page');
        assert.equal(await page.$eval(input, (element) => element.value), 'hmr-keeps-this');
      }
      // Plugin templates commonly use template.twig, without an .html suffix.
      // Exercise both ordinary saves and an editor's atomic rename save.
      for (const [label, atomic] of [
        ['after', false],
        ['before', true],
      ]) {
        if (atomic) {
          fs.writeFileSync(`${extensionTemplate}.tmp`, extensionMarkup(label));
          fs.renameSync(`${extensionTemplate}.tmp`, extensionTemplate);
        } else {
          fs.writeFileSync(extensionTemplate, extensionMarkup(label));
        }
        await page.waitForFunction(
          (text) =>
            window.hmrMarker !== 'same-page' ||
            document.querySelector('#extension-twig-counter')?.textContent === text,
          { timeout: 10000 },
          `${label} 1`,
        );
        assert.equal(
          await page.evaluate(() => window.hmrMarker),
          'same-page',
          'A plain .twig extension template must not reload the page',
        );
        assert.equal(
          await page.$eval('#extension-twig-counter', (element) => element.textContent),
          `${label} 1`,
        );
        assert.equal(await page.$eval(input, (element) => element.value), 'hmr-keeps-this');
      }
      // Script edits remount just the component, so new data, computed properties
      // and methods take effect without losing the surrounding page's state.
      for (const [initial, step, factor] of [
        [3, 2, 10],
        [0, 4, 100],
      ]) {
        fs.writeFileSync(extensionEntry, extensionScript(initial, step, factor));
        await page.waitForFunction(
          (text) =>
            window.hmrMarker !== 'same-page' ||
            document.querySelector('#extension-twig-counter')?.textContent === text,
          { timeout: 10000 },
          `before ${initial * factor}`,
        );
        assert.equal(await page.evaluate(() => window.hmrMarker), 'same-page');
        await page.click('#extension-twig-counter');
        assert.equal(
          await page.$eval('#extension-twig-counter', (el) => el.textContent),
          `before ${(initial + step) * factor}`,
        );
        assert.equal(await page.$eval(input, (el) => el.value), 'hmr-keeps-this');
        await page.waitForFunction(
          (text) => document.querySelector('#child-counter')?.textContent === text,
          { timeout: 10000 },
          `${initial * factor}`,
        );
        await page.click('#child-counter');
        assert.equal(
          await page.$eval('#child-counter', (el) => el.textContent),
          `${(initial + step) * factor}`,
        );
      }
      for (const value of [20, 30]) {
        fs.writeFileSync(lazyFile, lazyScript(value));
        await page.waitForFunction(
          (text) => document.querySelector('#lazy-component')?.textContent === text,
          {},
          String(value),
        );
        assert.equal(await page.evaluate(() => window.hmrMarker), 'same-page');
        assert.equal(await page.$eval(input, (el) => el.value), 'hmr-keeps-this');
      }
      // Template HMR must keep working after replacing the component definition.
      fs.writeFileSync(extensionTemplate, extensionMarkup('after-script'));
      await page.waitForFunction(
        () => document.querySelector('#extension-twig-counter')?.textContent === 'after-script 400',
      );
      assert.equal(await page.evaluate(() => window.hmrMarker), 'same-page');
      const text = (selector) => page.$eval(selector, (el) => el.textContent);
      const expectText = async (selector, expected) => {
        try {
          await page.waitForFunction(
            (selector, expected) => document.querySelector(selector)?.textContent === expected,
            { timeout: 10000 },
            selector,
            expected,
          );
        } catch (error) {
          t.diagnostic(
            JSON.stringify({
              selector,
              expected,
              actual: await text(selector).catch(() => null),
              marker: await page.evaluate(() => window.hmrMarker),
              errors,
              console: consoleMessages.slice(-40),
            }),
          );
          throw error;
        }
      };
      const twinA = '#mount-rspack-twin-a .twin';
      const twinB = '#mount-rspack-twin-b .twin';
      await page.click(twinA);
      await page.click(twinB);
      fs.writeFileSync(twins[0], twinMarkup('unique'));
      await expectText(twinA, 'unique 1');
      assert.equal(
        await text(twinB),
        'same 1',
        'Identical template text in another file stays untouched',
      );
      fs.writeFileSync(twins[0], twinMarkup('same'));
      await expectText(twinA, 'same 1');

      const counter = '#mount-rspack-override-probe .override-counter';
      const childCounter = '#mount-rspack-override-child .override-counter';
      await expectText(counter, 'OVERRIDE base A0 B0 0 M1');
      const snapshot = () =>
        page.evaluate(() => {
          const { Shopware } = window;
          const factory = Shopware.Application.getContainer('factory');
          const state = globalThis[Symbol.for('shopware-admin-rspack.legacy-hmr')];
          return {
            overrides: Shopware.Component.getOverrideRegistry().get('rspack-override-probe').length,
            templates: factory.template.getTemplateRegistry().get('rspack-override-probe').overrides
              .length,
            mixins: factory.mixin.getMixinRegistry().size,
            sources: state.sources.size,
            templateSources: state.templates.size,
          };
        });
      const initialSnapshot = await snapshot();
      for (let edit = 1; edit <= 12; edit++) {
        // Independent compilers may finish these updates in either order.
        fs.writeFileSync(overrideFile, overrideScript(edit));
        fs.writeFileSync(secondaryDefinition, secondaryScript(edit));
        fs.writeFileSync(mixinFile, mixinScript(edit + 1));
        await expectText(counter, `OVERRIDE base A${edit} B${edit} 0 M${edit + 1}`);
        await expectText(childCounter, `OVERRIDE base A${edit} B${edit} 0 M${edit + 1}`);
        await expectText('#named-mixin', `0 M${edit + 1}`);
        await expectText('#sfc-mixin', `SFC 0 M${edit + 1}`);
        // Remounting must clean up listeners from the old mixin instance.
        await page.evaluate(() => window.dispatchEvent(new Event('hmr-probe')));
        await expectText(counter, `OVERRIDE base A${edit} B${edit} ${edit + 1} M${edit + 1}`);
        await expectText(childCounter, `OVERRIDE base A${edit} B${edit} ${edit + 1} M${edit + 1}`);
        await expectText('#named-mixin', `${edit + 1} M${edit + 1}`);
        await expectText('#sfc-mixin', `SFC ${edit + 1} M${edit + 1}`);
        assert.deepEqual(
          await snapshot(),
          initialSnapshot,
          'Repeated saves do not accumulate registrations',
        );
      }
      fs.writeFileSync(sfcFile, sfcScript('NATIVE'));
      await expectText('#sfc-mixin', 'NATIVE 13 M13');
      fs.writeFileSync(overrideTemplate, overrideMarkup('TWIG'));
      await expectText(counter, 'TWIG base A12 B12 13 M13');
      await expectText(childCounter, 'TWIG base A12 B12 13 M13');
      // Removing the template option must remove its old override, too.
      fs.writeFileSync(overrideFile, overrideScript(13, false));
      await expectText(counter, 'BASE base A13 B12 0 M13');
      assert.equal((await snapshot()).templates, 0);
      fs.writeFileSync(overrideFile, overrideScript(14));
      await expectText(counter, 'TWIG base A14 B12 0 M13');
      assert.equal((await snapshot()).templates, 1);

      fs.writeFileSync(overrideFile, overrideScript(15, true, 2));
      await expectText(counter, 'TWIG base B12 A15 0 M13');
      fs.writeFileSync(overrideFile, overrideScript(14, true, 0));
      await expectText(counter, 'TWIG base A14 B12 0 M13');
      assert.deepEqual(await snapshot(), initialSnapshot);

      // A lazy override has its own cached resolver and may add/remove a template.
      fs.writeFileSync(secondaryDefinition, secondaryScript(12, true));
      await expectText(counter, 'SECOND base A14 B12 0 M13');
      assert.equal((await snapshot()).templates, 2);
      fs.writeFileSync(secondaryTemplate, overrideMarkup('SECOND-EDIT'));
      await expectText(counter, 'SECOND-EDIT base A14 B12 0 M13');
      fs.writeFileSync(secondaryDefinition, secondaryScript(12, false));
      await expectText(counter, 'TWIG base A14 B12 0 M13');
      assert.deepEqual(await snapshot(), initialSnapshot);

      let resolveBuild;
      watcher.compiler.hooks.done.tap('recovery-test', (stats) => {
        const resolve = resolveBuild;
        resolveBuild = null;
        // Allow the compiler to re-arm its file watcher before the next write.
        if (resolve) setTimeout(() => resolve(stats), 25);
      });
      const nextBuild = () =>
        new Promise((resolve) => {
          resolveBuild = resolve;
        });
      // Syntax errors and temporarily missing imports keep the last working UI.
      for (const missing of [false, true]) {
        const failed = nextBuild();
        if (missing) fs.unlinkSync(mixinFile);
        else fs.writeFileSync(mixinFile, 'export default { broken: ;');
        assert.equal((await failed).hasErrors(), true);
        assert.equal(await text(counter), `TWIG base A14 B12 0 M${missing ? 14 : 13}`);
        assert.equal(await page.evaluate(() => window.hmrMarker), 'same-page');
        const recovered = nextBuild();
        fs.writeFileSync(mixinFile, mixinScript(missing ? 15 : 14));
        assert.equal((await recovered).hasErrors(), false);
        await expectText(counter, `TWIG base A14 B12 0 M${missing ? 15 : 14}`);
      }
      assert.equal(await page.evaluate(() => window.hmrMarker), 'same-page');
      assert.equal(await page.$eval(input, (el) => el.value), 'hmr-keeps-this');
      // A template compiler error must also recover without discarding local state.
      await page.click(twinA);
      const failedTemplate = nextBuild();
      fs.writeFileSync(twins[0], '<button @click="(">broken</button>');
      await failedTemplate;
      // Wait for the runtime rejection, not merely compiler completion.
      await new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (errors.some((error) => error.startsWith('[Shopware HMR] Template update failed')))
            return resolve();
          if (Date.now() - started > 10000)
            return reject(new Error('Expected template compilation error'));
          setTimeout(poll, 20);
        };
        poll();
      });
      assert.equal(await text(twinA), 'same 2');
      fs.writeFileSync(twins[0], twinMarkup('recovered'));
      await expectText(twinA, 'recovered 2');
      assert.equal(await text(twinB), 'same 1');
      assert.equal(await page.evaluate(() => window.hmrMarker), 'same-page');
      assert.equal(
        errors.filter((error) => error.startsWith('[Shopware HMR] Template update failed')).length,
        1,
      );
      errors.splice(
        errors.findIndex((error) => error.startsWith('[Shopware HMR] Template update failed')),
        1,
      );
      for (let value = 16; value <= 20; value++) {
        fs.writeFileSync(mixinFile, mixinScript(value));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await expectText(counter, 'TWIG base A14 B12 0 M20');
      await expectText(childCounter, 'TWIG base A14 B12 0 M20');
      await expectText('#sfc-mixin', 'NATIVE 0 M20');
      assert.deepEqual(await snapshot(), initialSnapshot);
      assert.equal(await page.evaluate(() => window.hmrMarker), 'same-page');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await watcher.stop();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
);
