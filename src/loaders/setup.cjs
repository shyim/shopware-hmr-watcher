const path = require('node:path');
const fs = require('node:fs');
module.exports = function (source, map) {
  const { admin } = this.getOptions();
  const file = path.join(admin, 'build/vue-setup-transform/index.js');
  if (!fs.existsSync(file)) return this.callback(null, source, map);
  const { transformShopwareSetupSfc } = require(file);
  const result = transformShopwareSetupSfc(source, this.resourcePath);
  this.callback(null, result?.code || source, result?.map || map);
};
