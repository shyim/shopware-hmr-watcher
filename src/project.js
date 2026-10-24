import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { expand } from 'dotenv-expand';

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function discoverProject(root, environment = process.env) {
  root = fs.realpathSync(path.resolve(root));
  const env = {};
  for (const name of ['.env', '.env.local']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) Object.assign(env, parse(fs.readFileSync(file)));
  }
  Object.assign(env, environment);
  expand({ parsed: env, processEnv: env });
  const manifest = path.join(root, 'var/plugins.json');
  if (!fs.existsSync(manifest)) {
    throw new Error(
      `Missing ${manifest}. Run "php bin/console bundle:dump" in the Shopware root first.`,
    );
  }
  const bundles = readJson(manifest);
  const candidates = [
    bundles.Administration &&
      path.resolve(root, bundles.Administration.basePath, 'Resources/app/administration'),
    path.join(root, 'src/Administration/Resources/app/administration'),
    path.join(root, 'vendor/shopware/administration/Resources/app/administration'),
  ].filter(Boolean);
  const admin = candidates.find((dir) => fs.existsSync(path.join(dir, 'src/index.ts')));
  if (!admin) throw new Error(`Cannot find a supported Shopware Administration in ${root}.`);
  if (!fs.existsSync(path.join(admin, 'node_modules/vue'))) {
    throw new Error(`Install Administration dependencies first: npm ci --prefix ${admin}`);
  }
  const extensions = [];
  const names = new Set(['administration']);
  for (const [name, bundle] of Object.entries(bundles)) {
    const technicalName =
      bundle.technicalName || name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    if (Object.hasOwn(env, `SKIP_${technicalName.toUpperCase().replaceAll('-', '_')}`)) continue;
    const definition = bundle.administration;
    if (!definition?.entryFilePath) continue;
    if (!/^[a-zA-Z0-9_-]+$/.test(technicalName) || names.has(technicalName)) {
      throw new Error(`Invalid or duplicate extension technical name: ${technicalName}`);
    }
    names.add(technicalName);
    const base = path.resolve(root, bundle.basePath);
    const entry = path.resolve(base, definition.entryFilePath);
    if (!fs.existsSync(entry))
      throw new Error(`Missing entry for ${name}: ${entry}. Run bundle:dump again.`);
    extensions.push({
      name,
      technicalName,
      base,
      entry,
      source: path.resolve(base, definition.path || path.dirname(definition.entryFilePath)),
      folder: name
        .toLowerCase()
        .replace(/bundle$/, '')
        .replaceAll('-', ''),
      webpack: definition.webpack && path.resolve(base, definition.webpack),
    });
  }
  return { root, admin, env, extensions, manifest };
}

export function extensionManifest(extensions) {
  return Object.fromEntries([
    ['metadata', 'shopware'],
    ...extensions.map((extension) => [
      extension.technicalName,
      {
        js: `/_internal_ext/${extension.technicalName}/${extension.technicalName}.js`,
      },
    ]),
  ]);
}
