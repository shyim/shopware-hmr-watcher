import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RsdoctorRspackPlugin } from '@rsdoctor/core';
import { discoverProject } from '../src/project.js';
import { startWatcher } from '../src/server.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: 'string' }, watch: { type: 'boolean', default: false } },
});
if (positionals.length !== 1) {
  throw new Error('Usage: npm run profile -- /path/to/shopware [--output directory] [--watch]');
}
const directory = path.resolve(
  values.output || `reports/rsdoctor/${new Date().toISOString().replaceAll(':', '-')}`,
);
fs.mkdirSync(directory, { recursive: true });
const project = discoverProject(positionals[0]);
const watcher = await startWatcher(project, {
  port: 0,
  cache: false,
  configure(config) {
    config.plugins.push(
      new RsdoctorRspackPlugin({
        disableClientServer: true,
        linter: { rules: { 'ecma-version-check': ['Warn', { ecmaVersion: 2022 }] } },
        output: {
          reportDir: path.join(directory, config.name),
          mode: 'brief',
          options: { type: ['html', 'json'] },
        },
      }),
    );
  },
});
const stop = async () => {
  await watcher.stop();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const stats = await new Promise((resolve, reject) => {
    watcher.compiler.hooks.done.tap('rsdoctor-profile', resolve);
    for (const compiler of watcher.compiler.compilers)
      compiler.hooks.failed.tap('rsdoctor-profile', reject);
  });
  if (stats.hasErrors()) process.exitCode = 1;
  console.log(`Rsdoctor reports: ${directory}`);
  console.log('Profiling adds overhead; use npm run benchmark for normal build timings.');
  if (values.watch && !stats.hasErrors()) {
    console.log(`Watcher: http://localhost:${watcher.server.server.address().port}`);
  } else await stop();
} catch (error) {
  await stop();
  throw error;
}
