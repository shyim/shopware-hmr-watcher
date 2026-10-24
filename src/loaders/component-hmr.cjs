// Only definition modules get a self-accepting boundary. Route/module
// registration and unsupported dynamic definitions retain normal propagation.
module.exports = function transformComponent(ast, source, changes, imports, runtime) {
  const aliases = new Map();
  const wrappers = new Set();
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'vue') continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.imported.name === 'defineComponent')
        wrappers.add(specifier.local.name);
    }
  }
  for (const statement of ast.program.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const { id, init } of statement.declarations) {
      if (id.type === 'ObjectPattern' && init?.type === 'Identifier' && init.name === 'Shopware') {
        for (const property of id.properties) {
          if (property.type === 'ObjectProperty' && property.value.type === 'Identifier')
            aliases.set(property.value.name, property.key.name);
        }
      }
      if (
        id.type === 'Identifier' &&
        init?.type === 'MemberExpression' &&
        init.object.name === 'Shopware' &&
        !init.computed
      )
        aliases.set(id.name, init.property.name);
    }
  }
  const factoryName = (node) => {
    if (node?.type === 'Identifier') return aliases.get(node.name);
    if (
      node?.type === 'MemberExpression' &&
      !node.computed &&
      node.object.type === 'Identifier' &&
      node.object.name === 'Shopware'
    )
      return node.property.name;
  };
  const calls = [];
  const visit = (node, statement) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const factory = factoryName(node.callee.object);
      if (factory)
        calls.push({ expression: node, factory, method: node.callee.property.name, statement });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => visit(child, statement));
      else if (value && typeof value === 'object') visit(value, statement);
    }
  };
  for (const statement of ast.program.body) visit(statement, statement);
  if (calls.some(({ factory, method }) => factory === 'Module' && method === 'register')) return;
  const definitions = calls.filter(
    ({ factory, method }) =>
      (factory === 'Component' &&
        ['register', 'extend', 'override', 'wrapComponentConfig'].includes(method)) ||
      (factory === 'Mixin' && method === 'register'),
  );
  if (!definitions.length) return;
  // Re-evaluating unrelated top-level calls can duplicate listeners, timers or
  // application registrations. Those modules need normal HMR propagation.
  if (
    ast.program.body.some(
      (statement) =>
        statement.type === 'ExpressionStatement' &&
        statement.expression.type === 'CallExpression' &&
        !definitions.some(({ expression }) => expression === statement.expression),
    )
  )
    return;
  const isDefault = ({ statement, expression, method }) =>
    method === 'wrapComponentConfig' &&
    statement.type === 'ExportDefaultDeclaration' &&
    statement.declaration === expression;
  const direct = ({ expression, statement, method }) => {
    const config = expression.arguments[method === 'extend' ? 2 : 1];
    return (
      (['ObjectExpression', 'Identifier'].includes(config?.type) ||
        (config?.type === 'CallExpression' && wrappers.has(config.callee.name))) &&
      ((statement.type === 'ExpressionStatement' && statement.expression === expression) ||
        (statement.type === 'ExportDefaultDeclaration' && statement.declaration === expression))
    );
  };
  if (definitions.some((call) => !isDefault(call) && !direct(call))) return;
  imports.push(
    `import { componentModule as __swModule, registerComponent as __swRegister, registerMixin as __swMixin, componentConfig as __swConfig, applyComponentUpdate as __swApply } from ${runtime};`,
  );
  imports.push('const __swComponentScope = __swModule(import.meta.webpackHot);');
  for (const call of definitions) {
    const { expression, method, factory } = call;
    if (isDefault(call)) {
      changes.appendLeft(expression.start, '__swConfig(__swComponentScope, ');
      changes.appendRight(expression.end, ')');
      continue;
    }
    const receiver = source.slice(expression.callee.object.start, expression.callee.object.end);
    changes.overwrite(
      expression.callee.start,
      expression.arguments[0].start,
      factory === 'Mixin'
        ? `__swMixin(__swComponentScope, ${receiver}, `
        : `__swRegister(__swComponentScope, ${receiver}, ${JSON.stringify(method)}, `,
    );
  }
  changes.append('\n__swApply(__swComponentScope);\n');
};
