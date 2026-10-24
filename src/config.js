import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { rspack } from '@rspack/core';
import glob from 'fast-glob';
import { VueLoaderPlugin } from 'rspack-vue-loader';
import { readJson } from './project.js';
import { dateFnsLocaleContext } from './locales.js';

const require = createRequire(import.meta.url);
const directory = path.dirname(fileURLToPath(import.meta.url));
const loader = (name) => path.join(directory, 'loaders', `${name}.cjs`);

export function renderHtml(project) {
  const { admin, root, env } = project;
  const shared = path.resolve(admin, '../../shared/page-loading-screen');
  const featureFile = path.join(root, 'var/config_js_features.json');
  const data = {
    featureFlags: JSON.stringify(
      fs.existsSync(featureFile) ? readJson(featureFile) : {},
    ).replaceAll('<', '\\u003c'),
    serviceRegistryUrl: env.SERVICE_REGISTRY_URL || 'https://registry.services.shopware.io',
    analyticsGatewayUrl: env.PRODUCT_ANALYTICS_GATEWAY_URL || '',
    hideUpdateModule: ['1', 'true'].includes(env.SHOPWARE_AUTO_UPDATE_HIDE_MODULE || ''),
    'pageLoadingScreen.script': '',
    'pageLoadingScreen.style': '',
    'pageLoadingScreen.markup': '',
  };
  for (const [key, extension] of Object.entries({ script: 'js', style: 'css', markup: 'html' })) {
    const file = path.join(shared, `page-loading-screen.${extension}`);
    if (fs.existsSync(file)) data[`pageLoadingScreen.${key}`] = fs.readFileSync(file, 'utf8');
  }
  return fs
    .readFileSync(path.join(admin, 'index.html'), 'utf8')
    .replace(/<%-\s*([\w.]+)\s*%>/g, (_, key) => String(data[key] ?? ''))
    .replace(/<script\b[^>]*src=["']\/src\/index\.[jt]s["'][^>]*><\/script>/, '');
}

export function createConfigurations(project, options = {}) {
  const { admin, root, extensions } = project;
  const adminRequire = createRequire(path.join(admin, 'package.json'));
  const html = renderHtml(project);
  const cacheHash = createHash('sha256').update(
    JSON.stringify({
      html,
      sourcemap: options.sourcemap !== false,
      configure: options.configure?.toString(),
    }),
  );
  // Hash the target's transform implementations without pulling their Jest fixtures
  // into Rspack's build-dependency resolver.
  for (const file of glob
    .sync(
      [
        'build/vue-setup-transform/**/*.{js,ts}',
        'build/vite-plugins/virtual-shopware-modules/{index,definitions}.ts',
      ],
      {
        cwd: admin,
        absolute: true,
        ignore: ['**/*.spec.*', '**/index.spec/**', '**/fixtures/**', '**/_fixtures/**'],
      },
    )
    .sort()) {
    cacheHash.update(file).update(fs.readFileSync(file));
  }
  const cacheVersion = cacheHash.digest('hex');
  let dateFnsLocales;
  try {
    const meteorRequire = createRequire(
      adminRequire.resolve('@shopware-ag/meteor-component-library'),
    );
    dateFnsLocales = dateFnsLocaleContext(meteorRequire.resolve('date-fns/package.json'));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  const definitions = [
    {
      technicalName: 'administration',
      source: path.join(admin, 'src'),
      entry: path.join(admin, 'src/index.ts'),
    },
    ...extensions,
  ];
  return definitions.map((definition, index) => {
    const extension = index > 0;
    const name = definition.technicalName;
    const publicPath = extension ? `/_internal_ext/${name}/` : '/';
    const config = {
      name,
      mode: 'development',
      cache:
        options.cache === false
          ? true
          : {
              type: 'persistent',
              name: `shopware-${name}`,
              version: cacheVersion,
              storage: {
                type: 'filesystem',
                directory: path.join(root, 'var/cache/shopware-admin-rspack-cache'),
              },
              buildDependencies: [
                ...(options.configDependencies || []),
                directory,
                path.join(directory, '../package.json'),
                path.join(directory, '../package-lock.json'),
                path.join(admin, 'package.json'),
                path.join(admin, 'package-lock.json'),
                path.join(admin, 'index.html'),
                path.resolve(admin, '../../shared/page-loading-screen'),
                path.join(root, 'var/config_js_features.json'),
                project.manifest,
              ].filter((file) => file && fs.existsSync(file)),
            },
      context: extension ? path.dirname(definition.source) : admin,
      entry: { [name]: definition.entry },
      target: 'web',
      devtool: options.sourcemap === false ? false : 'cheap-module-source-map',
      output: {
        path: path.join(root, 'var/cache/shopware-admin-rspack', name),
        publicPath,
        filename: '[name].js',
        chunkFilename: 'chunks/[name].js',
        assetModuleFilename: 'assets/[name].[contenthash][ext]',
        uniqueName: `shopware-${name}`,
        clean: false,
      },
      resolve: {
        extensions: ['.ts', '.js', '.mjs', '.cjs', '.vue', '.json'],
        modules: [
          'node_modules',
          path.join(admin, 'node_modules'),
          path.join(directory, '../node_modules'),
        ],
        alias: {
          src: path.join(admin, 'src'),
          '~scss': path.join(admin, 'src/app/assets/scss'),
          scss: path.join(admin, 'src/app/assets/scss'),
          ...(!extension ? { vue$: adminRequire.resolve('vue/dist/vue.esm-bundler.js') } : {}),
          'process/browser': require.resolve('process/browser.js'),
        },
        fallback: {
          path: require.resolve('path-browserify'),
          events: require.resolve('events/'),
          fs: false,
        },
      },
      resolveLoader: { modules: [path.join(directory, '../node_modules')] },
      externalsType: 'window',
      externals: extension ? { vue: ['Shopware', 'Vue'] } : {},
      module: {
        rules: [
          {
            test: /\.[cm]?[jt]s$/,
            exclude: /node_modules/,
            resourceQuery: { not: [/raw|url|worker/] },
            enforce: 'pre',
            use: [
              {
                loader: loader('source'),
                options: {
                  admin,
                  extension,
                  entry: definition.entry,
                  sourceRoot: definition.source,
                },
              },
            ],
          },
          {
            test: /\.vue$/,
            exclude: /node_modules/,
            resourceQuery: { not: [/vue/] },
            enforce: 'pre',
            use: [{ loader: loader('setup'), options: { admin } }],
          },
          {
            test: /\.vue$/,
            loader: require.resolve('rspack-vue-loader'),
            options: {
              experimentalInlineMatchResource: true,
              template: { compilerOptions: { compatConfig: { MODE: 2 } } },
            },
          },
          {
            oneOf: [
              { resourceQuery: /(?:\?|&)raw(?:&|$)/, type: 'asset/source' },
              { resourceQuery: /(?:\?|&)url(?:&|$)/, type: 'asset/resource' },
              {
                resourceQuery: /(?:\?|&)(?:sharedworker|worker)(?:&|$)/,
                type: 'javascript/auto',
                loader: loader('worker'),
              },
              {
                test: /\.[cm]?tsx?$/,
                loader: 'builtin:swc-loader',
                options: {
                  jsc: { parser: { syntax: 'typescript', decorators: true }, target: 'es2022' },
                },
              },
              {
                test: /\.css$/,
                type: 'javascript/auto',
                use: [require.resolve('style-loader'), require.resolve('css-loader')],
              },
              {
                test: /\.(scss|sass)$/,
                type: 'javascript/auto',
                use: [
                  require.resolve('style-loader'),
                  require.resolve('css-loader'),
                  {
                    loader: require.resolve('sass-loader'),
                    options: {
                      implementation: require('sass-embedded'),
                      api: 'modern-compiler',
                      sassOptions: {
                        silenceDeprecations: [
                          'legacy-js-api',
                          'import',
                          'global-builtin',
                          'color-functions',
                          'if-function',
                        ],
                      },
                      warnRuleAsWarning: true,
                    },
                  },
                ],
              },
              { test: /\.(twig|html)$/, loader: loader('twig') },
              { test: /\.svg$/, dependency: 'url', type: 'asset/resource' },
              { test: /\.svg$/, loader: loader('svg'), options: { admin } },
              {
                test: /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|mp4|webm|pdf)$/,
                type: 'asset/resource',
              },
            ],
          },
        ],
      },
      plugins: [
        new VueLoaderPlugin(),
        // Meteor uses a dynamic bare import; package exports otherwise prevent
        // Rspack from resolving the locale directory as an import context.
        ...(dateFnsLocales
          ? [
              new rspack.ContextReplacementPlugin(
                /^date-fns\/locale$/,
                dateFnsLocales.directory,
                false,
                dateFnsLocales.pattern,
              ),
            ]
          : []),
        new rspack.DefinePlugin({
          __VUE_OPTIONS_API__: true,
          __VUE_PROD_DEVTOOLS__: false,
          __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
          'import.meta.env.DEV': true,
          'import.meta.env.PROD': false,
          'import.meta.env.MODE': JSON.stringify('development'),
          'import.meta.env.BASE_URL': JSON.stringify(publicPath),
          global: 'globalThis',
        }),
        new rspack.ProvidePlugin({ process: require.resolve('process/browser.js') }),
        ...(!extension
          ? [new rspack.HtmlRspackPlugin({ templateContent: html, scriptLoading: 'defer' })]
          : []),
      ],
      // Keep the last successful HMR graph across syntax errors. Emitting an
      // error module makes the browser replay that broken update after a fix.
      optimization: {
        // Share dependencies between lazy chunks within each compiler. Keep
        // extension entries self-contained: the manifest loads one entry URL.
        splitChunks: { chunks: 'async' },
        runtimeChunk: false,
        emitOnErrors: false,
      },
      watchOptions: {
        aggregateTimeout: 10,
        ignored: ['**/node_modules/**', '**/.git/**'],
        ...(options.poll ? { poll: options.poll } : {}),
      },
      stats: { preset: 'errors-warnings', timings: true },
      infrastructureLogging: { level: 'warn' },
    };
    return (
      options.configure?.(config, { project, extension: extension ? definition : null }) || config
    );
  });
}
