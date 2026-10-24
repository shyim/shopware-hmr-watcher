#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { discoverProject } from '../src/project.js';
import { startWatcher } from '../src/server.js';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      host: { type: 'string' },
      port: { type: 'string' },
      config: { type: 'string' },
      url: { type: 'string' },
      open: { type: 'boolean' },
      poll: { type: 'string' },
      'no-cache': { type: 'boolean' },
      'no-sourcemap': { type: 'boolean' },
      insecure: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(`Usage: shopware-admin-watch [shopware-root] [options]

Starts one Rspack MultiCompiler for the Administration and its extensions.
The root defaults to the current directory. Run bundle:dump and install the
Administration/extension npm dependencies in the target installation first.

  --url <url>       Shopware backend (defaults to APP_URL from its environment)
  --host <host>     Bind address (default: localhost)
  --port <port>     Dev server port (default: 5173)
  --config <file>   Customize each compiler with an exported configuration function
  --open            Open the browser
  --poll <ms>       Poll for changes (useful for mounted filesystems)
  --no-cache        Disable persistent cache (keep in-memory rebuild caching)
  --no-sourcemap    Disable source maps
  --insecure        Allow a backend with a self-signed TLS certificate
  -h, --help        Show help`);
  } else {
    if (positionals.length > 1) throw new Error('Expected one Shopware root. See --help.');
    for (const key of ['port', 'poll']) {
      if (
        values[key] !== undefined &&
        (!/^\d+$/.test(values[key]) ||
          Number(values[key]) < 1 ||
          (key === 'port' && Number(values[key]) > 65535))
      ) {
        throw new Error(`Invalid --${key}: ${values[key]}`);
      }
    }
    const project = discoverProject(positionals[0] || process.cwd());
    console.log(`Shopware root: ${project.root}`);
    console.log(
      `Compilers: administration${project.extensions.map((e) => `, ${e.technicalName}`).join('')}`,
    );
    for (const extension of project.extensions) {
      if (extension.webpack)
        console.warn(
          `${extension.name}: legacy webpack config is not loaded; use the package's shared Rspack loaders and aliases.`,
        );
    }
    const configFile = values.config && path.resolve(values.config);
    const configure = configFile
      ? (await import(pathToFileURL(configFile).href)).default
      : undefined;
    if (configFile && typeof configure !== 'function')
      throw new Error('--config must export a default function.');
    const watcher = await startWatcher(project, {
      ...values,
      configure,
      configDependencies: configFile ? [configFile] : [],
      port: Number(values.port) || undefined,
      poll: Number(values.poll) || undefined,
      sourcemap: !values['no-sourcemap'],
      cache: !values['no-cache'],
    });
    console.log(`Administration: http://${values.host || 'localhost'}:${values.port || 5173}`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await watcher.stop();
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
} catch (error) {
  console.error(`shopware-admin-watch: ${error.message}`);
  process.exitCode = 1;
}
