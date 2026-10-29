# Shopware HMR Watcher

[![CI](https://github.com/shyim/shopware-hmr-watcher/actions/workflows/ci.yml/badge.svg)](https://github.com/shyim/shopware-hmr-watcher/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**A standalone Shopware Administration watcher powered by Rspack.**

Point one CLI at your Shopware installation. Edit Twig templates, Vue components, overrides, and mixins with hot updates, while the Administration and its extensions build independently on a single development server.

```sh
shopware-admin-watch /path/to/shopware --open
```

> **Compatibility:** This project is experimental and targets the Vue 3 Administration. It has been tested against a Shopware development checkout; compatibility with individual Shopware releases is not yet established. See [requirements and compatibility](#requirements-and-compatibility) before adopting it.

## Features

- **Twig HMR:** Update `.twig` and `.html.twig` templates without losing component state, including inherited templates and overrides.
- **Component HMR:** Apply changes to component definitions, overrides, and registered mixins without refreshing the page.
- **Independent extension builds:** One Rspack MultiCompiler with a compiler for the Administration and each extension. Extensions share the host's Vue runtime.
- **Error recovery:** Keep the last successful build through syntax errors and temporarily missing imports, then resume hot updates when fixed.
- **Incremental builds:** Native JavaScript parsing, SWC for TypeScript, a persistent cache, and a reusable embedded Sass compiler.
- **Shopware-aware development server:** Serve development bundles in memory and proxy API, media, and thumbnail requests to your existing backend.

## Quick start

### 1. Prepare Shopware

Start your Shopware backend and install the npm dependencies for its Administration and extensions. From the Shopware root, refresh the bundle manifest:

```sh
php bin/console bundle:dump
```

### 2. Install the watcher

Install directly from GitHub:

```sh
npm install --global github:shyim/shopware-hmr-watcher
```

Or run from a checkout:

```sh
git clone https://github.com/shyim/shopware-hmr-watcher.git
cd shopware-hmr-watcher
npm ci
npm start -- /path/to/shopware
```

### 3. Start developing

```sh
shopware-admin-watch /path/to/shopware --open
```

The Administration is available at **<http://localhost:5173>**. If you run the command from your Shopware root, the path argument is optional.

The backend URL is read from `APP_URL`. Environment values are loaded in this order, with later values taking precedence: `.env`, `.env.local`, then the shell environment. Override the URL explicitly when needed:

```sh
shopware-admin-watch /path/to/shopware --url https://shopware.test
```

The watcher serves development assets in memory. It does not run the backend, install the target project's dependencies, or overwrite production bundles.

## Requirements and compatibility

- **Node.js 22.12 or newer.**
- A running Shopware backend and installed Administration/extension npm dependencies.
- A generated `var/plugins.json` manifest.
- A Vue 3 Administration containing `src/index.ts` and a development `index.html`.

Both source checkouts and Composer installations under `vendor/shopware/administration` are discovered automatically. Discovery of a directory layout does not guarantee compatibility with its Shopware version.

Legacy HMR integrates with Shopware's component, template, and mixin factories and its Vue view adapter. Incompatible adapter signatures produce a build error. Shopware setup-component and virtual-module transformations use the target installation's own implementations.

Supported source features include TypeScript, Vue SFCs, Twig, Sass/CSS, `shopware:*` imports, `import.meta.glob`, SVG components, raw/URL imports, and Worker/SharedWorker imports.

**Current scope:** Administration extension entries. Standalone Meteor iframe applications are not compiled. Existing extension webpack/Vite configuration files are not imported automatically; use [`--config`](#custom-configuration) for aliases, loaders, or plugins.

## Hot-update behavior

| Change                                                     | Behavior                                                | Component state               |
| ---------------------------------------------------------- | ------------------------------------------------------- | ----------------------------- |
| Twig template, including inherited templates and overrides | Re-render affected components                           | Preserved                     |
| Vue SFC template or CSS/Sass                               | Update in place                                         | Preserved                     |
| Supported component JavaScript/TypeScript definition       | Rebuild and remount affected components and descendants | Reset for affected components |
| Supported component override or registered mixin           | Rebuild affected consumers, preserving override order   | Reset for affected components |
| Code without an HMR boundary                               | Fall back to a page reload                              | Reset                         |

Supported definition patterns include `Component.register`, `Component.extend`, `Component.override`, and default-exported `Component.wrapComponentConfig` definitions, including lazily imported definitions. `Mixin.register` supports object definitions and default exports wrapped in Vue's `defineComponent`.

Mixed route/module registration files, unsupported dynamic registrations, unrelated top-level calls, and changes to registration names can require a full reload. Vue SFC script changes follow Vue's normal HMR behavior.

Twig files have independent identities, so identical template text in separate files stays isolated. Overlapping component updates are serialized to avoid applying an older asynchronous rebuild after a newer save. Template compilation failures retain the previous render and report the error in the browser console.

New files matched by `import.meta.glob` and new `*.override.vue` files are watched. **Restart the watcher after changing the extension list, feature flags, environment, or compiler configuration.**

## CLI reference

```text
Usage: shopware-admin-watch [shopware-root] [options]
```

| Option            | Description                                            | Default     |
| ----------------- | ------------------------------------------------------ | ----------- |
| `--url <url>`     | Shopware backend URL                                   | `APP_URL`   |
| `--host <host>`   | Development server bind address                        | `localhost` |
| `--port <port>`   | Development server port                                | `5173`      |
| `--config <file>` | ES module exporting a compiler customization function  | —           |
| `--open`          | Open the Administration in your browser                | Off         |
| `--poll <ms>`     | Poll for changes on mounted or network filesystems     | Off         |
| `--no-cache`      | Disable disk caching; retain in-memory rebuild caching | Off         |
| `--no-sourcemap`  | Disable source maps                                    | Off         |
| `--insecure`      | Accept a self-signed backend TLS certificate           | Off         |
| `-h`, `--help`    | Show help                                              | —           |

Exclude an extension with a `SKIP_<TECHNICAL_NAME>` environment variable, replacing hyphens with underscores:

```sh
SKIP_FROSH_TOOLS=1 shopware-admin-watch /path/to/shopware
```

The presence of the variable excludes the extension, regardless of its value. Unset it to include the extension again.

## Custom configuration

Create `rspack.watch.mjs`:

```js
export default function configure(config, { project, extension }) {
  if (extension?.technicalName === 'my-plugin') {
    config.resolve.alias['my-library'] = '/absolute/path/to/my-library';
  }

  return config;
}
```

```sh
shopware-admin-watch /path/to/shopware --config ./rspack.watch.mjs
```

The hook runs synchronously once per compiler. `project` contains the root, Administration path, environment, and discovered extensions; `extension` is `null` for the Administration compiler.

Keep each compiler's output public path and runtime name distinct. Extension entries are loaded through `sw-plugin-dev.json`, so any changes to entry assets must remain compatible with that loading mechanism.

## Performance and profiling

The watcher uses Rspack 2.3's native JavaScript parsing, SWC for TypeScript, and Sass's `modern-compiler` API. Content filters skip the custom source loader for files without Shopware imports, globs, or component/mixin definitions. Extension entries and Shopware's HMR integration files always run through the loader. Shared dependencies are extracted between async chunks within each compiler, while extension entries stay self-contained.

The native file watcher is enabled by default; `--poll` uses Watchpack for polling mounted or network filesystems. Persistent caches use Rspack's experimental `newCache` implementation and live in the Shopware installation's `var/cache/shopware-admin-rspack-cache` directory. `--no-cache` retains memory caching without reading or writing the disk cache. Per-loader caching is not enabled because the current Vue loader strips that option when cloning rules.

To switch back to the previous cache or file watcher, use the [custom configuration hook](#custom-configuration):

```js
export default function configure(config) {
  config.experiments.newCache = false;
  config.experiments.nativeWatcher = false;
  return config;
}
```

Run these commands from a watcher checkout to compare a fresh compilation with cached restarts:

```sh
npm run benchmark -- /path/to/shopware --no-cache
npm run benchmark -- /path/to/shopware
npm run benchmark -- /path/to/shopware
```

The benchmark reports startup and per-compiler timings, module/chunk counts, and emitted JavaScript bytes. Byte counts include all initial and async JavaScript assets, excluding source maps; they are not initial page download sizes. Timings exclude browser startup and backend requests.

Generate [Rsdoctor](https://rsdoctor.rs/) reports for every compiler:

```sh
npm run profile -- /path/to/shopware --output reports/rsdoctor/current
```

Add `--watch` to keep the profiled watcher running and update reports on rebuild. Without `--output`, reports go into a timestamped directory under `reports/rsdoctor`.

Open the interactive Administration report:

```sh
npx rsdoctor analyze --profile reports/rsdoctor/current/administration/rsdoctor-data.json
```

Replace `administration` with an extension's technical name to inspect its compiler. Each directory also contains an HTML report.

Profiling disables persistent caching and adds instrumentation overhead. Use the ordinary benchmark for timing comparisons. Loader durations overlap and include waiting; their sum is not CPU time or wall-clock build duration. Shopware deliberately imports registrations for their side effects, so the corresponding Rsdoctor tree-shaking warnings need to be assessed in that context.

## Troubleshooting

| Symptom                             | What to check                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Missing manifest or extension entry | Run `php bin/console bundle:dump` again in the Shopware root.                                                                              |
| Missing Administration dependencies | Install dependencies in the discovered Administration directory and affected extensions.                                                   |
| Backend requests fail               | Check `APP_URL`, use `--url`, and confirm the backend is running. Use `--insecure` for a local self-signed certificate.                    |
| File changes are not detected       | Try `--poll 250`, especially with Docker bind mounts or network filesystems.                                                               |
| An edit reloads the page            | Check the supported HMR patterns above and the browser console for the update that triggered the reload.                                   |
| Unsupported HMR adapter error       | The target Shopware factory or adapter differs from the supported structure. Include the Shopware version and error when opening an issue. |
| A new extension does not appear     | Regenerate the bundle manifest and restart the watcher.                                                                                    |

## Development

```sh
npm ci
npm run check
npm run format:check
```

Browser tests use an installed Chrome/Chromium. Set `CHROME_BIN` to its executable path if automatic discovery cannot find it. The ordinary suite runs without a Shopware installation; tests requiring unavailable browser or Shopware fixtures are skipped.

To also run the real-Shopware integration test:

```sh
SHOPWARE_ROOT=/path/to/shopware npm run check
```

It exercises login-page Twig HMR, component scripts, override ordering, mixins, concurrent extension updates, rapid saves, and error recovery. Temporary fixtures and template aliases keep Shopware source files untouched; the test does not log in.

Bug reports and pull requests are welcome. Include the Shopware, Node.js, and watcher versions, the failing command, and a minimal reproduction when possible.

## License

[MIT](LICENSE) © Soner Sayakci
