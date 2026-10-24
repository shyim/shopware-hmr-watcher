const path = require('node:path');
const { createHash } = require('node:crypto');
module.exports = function (source) {
  const template = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!this.resourcePath.endsWith('.twig')) return `export default ${JSON.stringify(template)};`;
  const id = createHash('sha256').update(this.resourcePath).digest('hex');
  return `import { templateSource, updateTemplate } from ${JSON.stringify(path.join(__dirname, '../runtime/legacy-hmr.js'))};
const source = ${JSON.stringify(template)};
export default templateSource(${JSON.stringify(id)}, source);
if (import.meta.webpackHot) {
  import.meta.webpackHot.accept();
  if (import.meta.webpackHot.data) updateTemplate(${JSON.stringify(id)}, source);
  import.meta.webpackHot.dispose(() => {});
}`;
};
