import { performance } from 'node:perf_hooks';
import { discoverProject } from '../src/project.js';
import { startWatcher } from '../src/server.js';

const root = process.argv[2];
if (!root) throw new Error('Usage: npm run benchmark -- /path/to/shopware [--no-cache]');
const project = discoverProject(root);
const start = performance.now();
const watcher = await startWatcher(project, {
  port: 0,
  cache: !process.argv.includes('--no-cache'),
});
try {
  const stats = await new Promise((resolve, reject) => {
    watcher.compiler.hooks.done.tap('benchmark', resolve);
    for (const compiler of watcher.compiler.compilers)
      compiler.hooks.failed.tap('benchmark', reject);
  });
  console.log(
    JSON.stringify(
      {
        readyMs: Math.round(performance.now() - start),
        compilers: stats.stats.map((result) => ({
          name: result.compilation.name,
          buildMs: result.endTime - result.startTime,
          modules: result.compilation.modules.size,
          chunks: result.compilation.chunks.size,
          javascriptBytes: result.compilation
            .getAssets()
            .filter((asset) => asset.name.endsWith('.js'))
            .reduce((total, asset) => total + asset.source.size(), 0),
        })),
      },
      null,
      2,
    ),
  );
  if (stats.hasErrors()) process.exitCode = 1;
} finally {
  await watcher.stop();
}
