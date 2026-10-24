const path = require('node:path');
const { parse } = require('@babel/parser');
const MagicString = require('magic-string');
const glob = require('fast-glob');
const transformComponent = require('./component-hmr.cjs');

function literal(node) {
  if (node.type === 'StringLiteral' || node.type === 'BooleanLiteral') return node.value;
  if (node.type === 'ArrayExpression') return node.elements.map(literal);
  if (node.type === 'ObjectExpression')
    return Object.fromEntries(
      node.properties.map((p) => [p.key.name || p.key.value, literal(p.value)]),
    );
  throw new Error('import.meta.glob arguments must be literals');
}

module.exports = function (source, map) {
  const { admin, extension, entry, sourceRoot } = this.getOptions();
  const changes = new MagicString(source);
  const imports = [];
  const runtime = JSON.stringify(path.join(__dirname, '../runtime/legacy-hmr.js'));
  if (this.resourcePath === path.join(admin, 'src/app/adapter/view/vue.adapter.ts')) {
    imports.push(`import { registerLegacyComponent as __swRegisterHmr } from ${runtime};`);
    const call = 'this.resolveMixins(componentConfig);';
    if (!source.includes(call))
      throw new Error('Unsupported Shopware view adapter: cannot install HMR adapter');
    for (const match of source.matchAll(/this\.resolveMixins\(componentConfig\);/g)) {
      changes.appendLeft(
        match.index + call.length,
        ' __swRegisterHmr(componentName, componentConfig, this);',
      );
    }
  }
  if (this.resourcePath === path.join(admin, 'src/core/factory/template.factory.js')) {
    imports.push(`import { currentTemplate as __swCurrentTemplate } from ${runtime};`);
    for (const [name, argument] of [
      ['registerComponentTemplate', 'componentTemplate'],
      ['extendComponentTemplate', 'templateExtension'],
      ['registerTemplateOverride', 'templateOverride'],
    ]) {
      const pattern = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{`);
      const match = pattern.exec(source);
      if (!match) throw new Error(`Unsupported Shopware template factory: missing ${name}`);
      changes.appendLeft(
        match.index + match[0].length,
        `\n${argument} = __swCurrentTemplate(${argument});`,
      );
    }
  }
  if (this.resourcePath === path.join(admin, 'src/core/factory/async-component.factory.ts')) {
    imports.push(
      `import { componentEpoch as __swEpoch, trackOverride as __swTrackOverride, registerOverrideTemplate as __swOverrideTemplate } from ${runtime};`,
    );
    const caches = [...source.matchAll(/let config: ComponentConfig;/g)];
    const cacheChecks = [...source.matchAll(/if \(config\) \{\s*return config;\s*\}/g)];
    if (caches.length !== 2 || cacheChecks.length !== 2) {
      throw new Error('Unsupported Shopware component cache: cannot install HMR adapter');
    }
    for (const match of caches) {
      changes.appendLeft(match.index + match[0].length, '\nlet __swConfigEpoch = -1;');
    }
    for (const match of cacheChecks) {
      changes.overwrite(
        match.index,
        match.index + match[0].length,
        'if (config && __swConfigEpoch === __swEpoch()) { return config; }\n__swConfigEpoch = __swEpoch();',
      );
    }
    const overrideCall =
      'TemplateFactory.registerTemplateOverride(componentName, config.template as string, overrideIndex);';
    const callIndex = source.indexOf(overrideCall);
    if (callIndex === -1)
      throw new Error('Unsupported Shopware override factory: cannot install HMR adapter');
    changes.overwrite(
      callIndex,
      callIndex + overrideCall.length,
      '__swOverrideTemplate(configResolveMethod, componentName, config.template as string, overrideIndex, TemplateFactory);',
    );
    const overrideStart = source.indexOf('function override(');
    const configIndex = source.indexOf('config.name = componentName;', overrideStart);
    if (overrideStart === -1 || configIndex === -1)
      throw new Error('Unsupported Shopware override configuration: cannot install HMR adapter');
    changes.appendLeft(configIndex, 'config = { ...config };\n');
    const registerCall = 'overrideRegistry.set(componentName, overrides);';
    const registerIndex = source.indexOf(registerCall, overrideStart);
    if (registerIndex === -1)
      throw new Error('Unsupported Shopware override registry: cannot install HMR adapter');
    changes.appendLeft(
      registerIndex + registerCall.length,
      '\n__swTrackOverride(configResolveMethod);',
    );
  }
  const componentDefinition = /\b(?:Component|Mixin)\b/.test(source);
  if (source.includes('import.meta.glob') || source.includes('shopware:') || componentDefinition) {
    const ast = parse(source, {
      sourceType: 'unambiguous',
      plugins: [
        'typescript',
        'decorators-legacy',
        ...(/\.[jt]sx$/.test(this.resourcePath) ? ['jsx'] : []),
      ],
    });
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      const specifier =
        node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration'
          ? node.source
          : node.type === 'ImportExpression'
            ? node.source
            : node.type === 'CallExpression' && node.callee.type === 'Import'
              ? node.arguments[0]
              : null;
      if (specifier?.type === 'StringLiteral' && specifier.value.startsWith('shopware:')) {
        const loader = path.join(__dirname, 'virtual.cjs');
        const options = JSON.stringify({ admin, extension, specifier: specifier.value });
        changes.overwrite(
          specifier.start,
          specifier.end,
          JSON.stringify(`!!${loader}?${options}!${path.join(__dirname, '../empty.js')}`),
        );
      }
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'MetaProperty' &&
        node.callee.object.meta.name === 'import' &&
        node.callee.property.name === 'glob'
      ) {
        const patterns = [literal(node.arguments[0])].flat();
        const options = node.arguments[1] ? literal(node.arguments[1]) : {};
        const cwd = path.dirname(this.resourcePath);
        const normalized = patterns.map((p) => p.replace(/^(!?)\//, `$1${admin}/`));
        for (const task of glob.generateTasks(normalized, { cwd }))
          this.addContextDependency(path.resolve(cwd, task.base));
        const files = glob
          .sync(normalized, { cwd, onlyFiles: true, dot: false })
          .filter((file) => path.resolve(cwd, file) !== this.resourcePath)
          .sort();
        const entries = files.map((file) => {
          const key = path.isAbsolute(file)
            ? '/' + path.relative(admin, file).split(path.sep).join('/')
            : './' + file.replace(/^\.\//, '');
          const request =
            path.resolve(cwd, file) +
            (options.query || (options.as === 'raw' ? '?raw' : options.as === 'url' ? '?url' : ''));
          let expression;
          if (options.eager) {
            const binding = `__swGlob${imports.length}`;
            imports.push(`import * as ${binding} from ${JSON.stringify(request)};`);
            expression = options.import ? `${binding}[${JSON.stringify(options.import)}]` : binding;
          } else {
            expression =
              `() => import(${JSON.stringify(request)})` +
              (options.import ? `.then(m => m[${JSON.stringify(options.import)}])` : '');
          }
          return `${JSON.stringify(key)}: ${expression}`;
        });
        changes.overwrite(node.start, node.end, `({${entries.join(',')}})`);
        return;
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(ast.program);
    if (componentDefinition && /\.[jt]s$/.test(this.resourcePath)) {
      transformComponent(ast, source, changes, imports, runtime);
    }
  }
  if (extension && this.resourcePath === entry) {
    this.addContextDependency(sourceRoot);
    for (const [index, file] of glob
      .sync('**/*.override.vue', { cwd: sourceRoot, absolute: true })
      .sort()
      .entries()) {
      imports.push(
        `import __swOverride${index} from ${JSON.stringify(file)};\nShopware.Component.registerOverrideComponent(__swOverride${index});`,
      );
    }
  }
  if (imports.length) changes.prepend(imports.join('\n') + '\n');
  this.callback(
    null,
    changes.toString(),
    changes.hasChanged()
      ? changes.generateMap({ hires: true, source: this.resourcePath, includeContent: true })
      : map,
  );
};
