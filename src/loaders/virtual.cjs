const path = require('node:path');
const fs = require('node:fs');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
module.exports = function () {
  const { admin, extension, specifier } = this.getOptions();
  const registryFile = path.join(admin, 'shopware-modules.json');
  this.addDependency(registryFile);
  const { generateModuleSource } = jiti(
    path.join(admin, 'build/vite-plugins/virtual-shopware-modules/index.ts'),
  );
  const source = generateModuleSource(
    specifier,
    JSON.parse(fs.readFileSync(registryFile, 'utf8')),
    extension ? 'extension' : 'host',
  );
  if (!source) throw new Error(`Unknown Shopware import: ${specifier}`);
  return source;
};
