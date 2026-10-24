import fs from 'node:fs';
import path from 'node:path';

// date-fns also ships index/CDN bundles alongside its individual locales.
// Derive a whitelist from public exports, retaining every supported locale.
export function dateFnsLocaleContext(packageFile) {
  const directory = path.join(path.dirname(packageFile), 'locale');
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  let names = Object.keys(manifest.exports || {})
    .filter((request) => /^\.\/locale\/[A-Za-z0-9-]+$/.test(request))
    .map((request) => request.slice('./locale/'.length));
  if (!names.length) {
    // date-fns 2 exposes directories rather than package exports.
    names = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^[A-Za-z0-9-]+$/.test(entry.name) &&
          fs.existsSync(path.join(directory, entry.name, 'index.js')),
      )
      .map((entry) => entry.name);
  }
  return {
    directory,
    pattern: names.length ? new RegExp(`^\\./(?:${names.join('|')})(?:\\.js)?$`) : /(?!)/,
  };
}
