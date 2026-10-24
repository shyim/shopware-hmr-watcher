const { createRequire } = require('node:module');
const path = require('node:path');
module.exports = function (source) {
  const requireAdmin = createRequire(path.join(this.getOptions().admin, 'package.json'));
  const { compileTemplate } = requireAdmin('@vue/compiler-sfc');
  const result = compileTemplate({ source, filename: this.resourcePath, id: this.resourcePath });
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  return `${result.code}\nexport default { render };`;
};
