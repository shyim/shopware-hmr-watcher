import fs from 'node:fs';
import path from 'node:path';
import { rspack } from '@rspack/core';
import { RspackDevServer } from '@rspack/dev-server';
import { createConfigurations } from './config.js';
import { extensionManifest } from './project.js';

export async function startWatcher(project, options = {}) {
  const backend = options.url || project.env.APP_URL;
  if (!backend)
    throw new Error(
      'Set APP_URL in the Shopware .env/.env.local or pass --url https://your-shop.test.',
    );
  const url = new URL(backend);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('--url / APP_URL must be an HTTP(S) URL.');
  const configs = createConfigurations(project, options);
  const compiler = rspack(configs);
  const staticDirectories = [
    {
      directory: path.join(project.admin, 'static'),
      publicPath: ['/static', '/bundles/administration/administration/static'],
    },
    ...project.extensions.map((extension) => ({
      directory: path.resolve(extension.source, '../static'),
      publicPath: `/bundles/${extension.folder}/administration/static`,
    })),
  ]
    .filter((item) => fs.existsSync(item.directory))
    .map((item) => ({ ...item, watch: true }));
  const server = new RspackDevServer(
    {
      host: options.host || 'localhost',
      port: options.port ?? 5173,
      setupExitSignals: false,
      hot: true,
      liveReload: true,
      open: Boolean(options.open),
      client: { overlay: { errors: true, warnings: false, runtimeErrors: false } },
      devMiddleware: { writeToDisk: false, stats: { preset: 'errors-warnings', timings: true } },
      static: staticDirectories,
      historyApiFallback: true,
      proxy: [
        {
          context: ['/api', '/bundles', '/media', '/thumbnail'],
          target: backend,
          changeOrigin: true,
          secure: !options.insecure,
        },
      ],
      setupMiddlewares(middlewares) {
        // Source assets must win over the backend's stale public/bundles copies.
        const staticMiddleware = middlewares.filter((item) => item.name === 'serve-static');
        middlewares = middlewares.filter((item) => item.name !== 'serve-static');
        const proxyIndex = middlewares.findIndex((item) => item.name === 'http-proxy-middleware');
        middlewares.splice(proxyIndex < 0 ? 0 : proxyIndex, 0, ...staticMiddleware);
        middlewares.unshift({
          name: 'shopware-extension-manifest',
          middleware(req, res, next) {
            if (req.url?.split('?')[0].endsWith('/sw-plugin-dev.json')) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(extensionManifest(project.extensions)));
              return;
            }
            next();
          },
        });
        return middlewares;
      },
    },
    compiler,
  );
  try {
    await server.start();
  } catch (error) {
    await new Promise((resolve) => compiler.close(resolve));
    throw error;
  }
  let stopping;
  return {
    server,
    compiler,
    stop: () => {
      stopping ??= (async () => {
        await server.stop();
        await new Promise((resolve, reject) =>
          compiler.close((error) => (error ? reject(error) : resolve())),
        );
      })();
      return stopping;
    },
  };
}
