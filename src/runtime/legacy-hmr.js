// Shared by the Administration and every independent extension runtime.
const stateKey = Symbol.for('shopware-admin-rspack.legacy-hmr');
const state = (globalThis[stateKey] ??= {
  components: new Map(),
  templates: new Map(),
  sources: new Map(),
  mixins: new Map(),
  overrideTokens: new WeakMap(),
  nextOverrideOrder: 0,
  templateTokens: new WeakMap(),
  pending: new Set(),
  epoch: 0,
  scheduled: false,
  updating: false,
});
const sourceKey = Symbol.for('shopware-admin-rspack.component-source');
const mixinKey = Symbol.for('shopware-admin-rspack.mixin-source');
const templatePattern = /^\{# sw-rspack:([a-f0-9]+) #\}/;
const templateFactory = () => globalThis.Shopware?.Application.getContainer('factory').template;

// Keep Shopware's public string contract. Twig discards this development-only
// comment when rendering; the identity survives config cloning and lazy imports.
export function templateSource(id, source) {
  const template = `{# sw-rspack:${id} #}${source}`;
  if (!state.templates.has(id)) state.templates.set(id, template);
  return template;
}

export function currentTemplate(template) {
  const id = typeof template === 'string' && templatePattern.exec(template)?.[1];
  return state.templates.get(id) ?? template;
}

export function componentEpoch() {
  return state.epoch;
}

function visitDefinitions(config, visit, seen = new Set()) {
  if (!config || typeof config !== 'object' || seen.has(config)) return;
  seen.add(config);
  visit(config);
  visitDefinitions(config.extends, visit, seen);
  for (const mixin of config.mixins || []) visitDefinitions(mixin, visit, seen);
}

export function registerLegacyComponent(name, config, adapter) {
  if (!globalThis.__VUE_HMR_RUNTIME__) return;
  visitDefinitions(config, (definition) => {
    // Shopware clones extended configurations. Refresh cloned mixins too.
    if (definition.mixins) {
      definition.mixins = definition.mixins.map(
        (mixin) => state.mixins.get(mixin?.[mixinKey]) ?? mixin,
      );
    }
    state.sources.get(definition[sourceKey])?.names.add(name);
  });
  // Native Vue SFCs keep their loader-generated ID, but still need to be
  // tracked when they consume a self-accepting Shopware mixin definition.
  const id = config.__hmrId || `shopware-legacy:${name}`;
  config.__hmrId = id;
  globalThis.__VUE_HMR_RUNTIME__.createRecord(id, config);
  state.components.set(name, { id, config, adapter });
}

export function componentModule(hot) {
  const previous = hot?.data?.components;
  if (hot?.data) delete hot.data.components;
  const scope = {
    hot,
    previous,
    names: previous?.names || new Set(),
    registrations: [],
    defaultConfig: null,
    key: previous?.key || Symbol(),
  };
  state.sources.set(scope.key, scope);
  if (hot) {
    hot.accept();
    hot.dispose((data) => {
      data.components = scope;
    });
  }
  return scope;
}

function replaceObject(previous, next) {
  if (!previous) return next;
  for (const key of Reflect.ownKeys(previous)) delete previous[key];
  Object.assign(previous, next);
  return previous;
}

export function registerComponent(scope, factory, method, ...args) {
  const name = args[0];
  const previous = scope.previous?.registrations[scope.registrations.length];
  const registry = factory.getComponentRegistry();
  const matching = previous?.name === name && previous.method === method;
  if (matching && registry.get(name) === previous.resolver) registry.delete(name);
  const resolver = factory[method](...args);
  if (method === 'override' && matching) {
    const overrides = factory.getOverrideRegistry().get(name);
    const newIndex = overrides.findIndex((item) => item.config === resolver);
    if (overrides.some((item) => item.config === previous.resolver) && newIndex !== -1) {
      const [replacement] = overrides.splice(newIndex, 1);
      const oldIndex = overrides.findIndex((item) => item.config === previous.resolver);
      overrides.splice(oldIndex, 1, replacement);
    }
    const token = state.overrideTokens.get(previous.resolver);
    if (token) {
      removeOverrideTemplate(name, token);
      token.resolver = resolver;
      state.overrideTokens.set(resolver, token);
    }
    overrides.sort(
      (a, b) =>
        a.index - b.index ||
        state.overrideTokens.get(a.config).order - state.overrideTokens.get(b.config).order,
    );
  }
  scope.registrations.push({ name, method, resolver });
  scope.names.add(name);
  return resolver;
}

export function trackOverride(resolver) {
  state.overrideTokens.set(resolver, { resolver, order: state.nextOverrideOrder++ });
}

function removeOverrideTemplate(name, token) {
  const overrides = templateFactory()?.getTemplateRegistry().get(name)?.overrides;
  const index = overrides?.indexOf(token.item);
  if (index >= 0) overrides.splice(index, 1);
  token.item = null;
}

// Invoked from Shopware's async factory for all overrides, including lazy ones.
export function registerOverrideTemplate(resolver, name, template, index, factory) {
  const token = state.overrideTokens.get(resolver) ?? { resolver };
  state.overrideTokens.set(resolver, token);
  removeOverrideTemplate(name, token);
  const before = new Set(factory.getTemplateRegistry().get(name)?.overrides);
  factory.registerTemplateOverride(name, template, index);
  const overrides = factory.getTemplateRegistry().get(name).overrides;
  token.item = overrides.find((item) => !before.has(item));
  state.templateTokens.set(token.item, token);
  // Preserve registry order even when async resolvers finish out of order.
  const order = globalThis.Shopware.Component.getOverrideRegistry().get(name) || [];
  overrides.sort((a, b) => {
    const position = (item) =>
      order.findIndex((entry) => entry.config === state.templateTokens.get(item)?.resolver);
    return a.index - b.index || position(a) - position(b);
  });
}

export function registerMixin(scope, factory, name, config) {
  const previous = scope.previous?.registrations[scope.registrations.length];
  const registry = globalThis.Shopware.Application.getContainer('factory').mixin.getMixinRegistry();
  const matching =
    previous?.method === 'mixin' &&
    previous.name === name &&
    registry.get(name) === previous.resolver;
  if (matching) {
    config = replaceObject(previous.resolver, config);
    registry.delete(name);
  }
  const key = matching ? previous.key : Symbol();
  config[sourceKey] = scope.key;
  config[mixinKey] = key;
  const resolver = factory.register(name, config);
  // Do not take ownership of another module's duplicate registration.
  if (resolver === config) state.mixins.set(key, config);
  scope.registrations.push({ name, method: 'mixin', resolver, key });
  return resolver;
}

export function componentConfig(scope, config) {
  config = replaceObject(scope.previous?.defaultConfig, config);
  config[sourceKey] = scope.key;
  scope.defaultConfig = config;
  return config;
}

function addDescendants(affected) {
  let size;
  do {
    size = affected.size;
    for (const [name, component] of state.components) {
      visitDefinitions(component.config.extends, (parent) => {
        if (affected.has(parent.name)) affected.add(name);
      });
    }
  } while (size !== affected.size);
}

function clearTemplates() {
  const factory = templateFactory();
  factory?.clearTwigCache();
  factory?.getNormalizedTemplateRegistry().clear();
}

export function applyComponentUpdate(scope) {
  const previous = scope.previous;
  scope.previous = null;
  if (!previous) return;
  if (
    previous.registrations.length !== scope.registrations.length ||
    previous.registrations.some(
      (record, index) =>
        record.name !== scope.registrations[index].name ||
        record.method !== scope.registrations[index].method,
    )
  ) {
    scope.hot.invalidate();
    return;
  }
  state.epoch++;
  for (const name of scope.names) state.pending.add(name);
  scheduleUpdates();
}

function scheduleUpdates() {
  if (state.scheduled || state.updating) return;
  state.scheduled = true;
  queueMicrotask(async () => {
    state.scheduled = false;
    state.updating = true;
    const epoch = state.epoch;
    const affected = new Set(state.pending);
    state.pending.clear();
    addDescendants(affected);
    try {
      // All override resolvers will rebuild in this epoch. Drop their previous
      // templates even when a lazy override has removed its template option.
      for (const name of affected) {
        const overrides = templateFactory()?.getTemplateRegistry().get(name)?.overrides || [];
        for (const item of [...overrides]) {
          const token = state.templateTokens.get(item);
          if (token) removeOverrideTemplate(name, token);
        }
      }
      clearTemplates();
      for (const name of affected) {
        state.components.get(name)?.adapter.resolvedComponentConfigs.delete(name);
      }
      const updates = [];
      for (const name of affected) {
        const component = state.components.get(name);
        if (!component) continue;
        const config = await component.adapter.componentResolver(name);
        if (config === false) throw new Error(`Cannot rebuild component ${name}`);
        updates.push({ component, config });
      }
      if (epoch === state.epoch) {
        for (const { component, config } of updates) {
          globalThis.__VUE_HMR_RUNTIME__.reload(component.id, config);
        }
      } else {
        // A newer save arrived while a lazy definition was resolving.
        for (const name of affected) state.pending.add(name);
      }
    } catch (error) {
      console.error(
        '[Shopware HMR] Component update failed; fix the source and save again:',
        error,
      );
      // Retry these components on the next successful module update.
      for (const name of affected) state.pending.add(name);
    } finally {
      state.updating = false;
      if (epoch !== state.epoch) scheduleUpdates();
    }
  });
}

export function updateTemplate(id, source) {
  const next = templateSource(id, source);
  const previous = state.templates.get(id);
  if (previous === next) return;
  const factory = templateFactory();
  if (!factory) {
    state.templates.set(id, next);
    return;
  }
  const changed = [];
  const affected = new Set();
  const registry = factory.getTemplateRegistry();
  for (const [name, definition] of registry) {
    for (const item of [definition, ...(definition.overrides || [])]) {
      if (templatePattern.exec(item.raw)?.[1] === id) {
        changed.push([item, item.raw]);
        item.raw = next;
        affected.add(name);
      }
    }
  }
  let size;
  do {
    size = affected.size;
    for (const [name, definition] of registry) {
      const parent =
        typeof definition.extend === 'string' ? definition.extend : definition.extend?.name;
      if (affected.has(parent)) affected.add(name);
    }
  } while (size !== affected.size);
  try {
    clearTemplates();
    const renders = [];
    for (const name of affected) {
      const component = state.components.get(name);
      if (!component) continue;
      const template = factory.getRenderedTemplate(name);
      if (typeof template !== 'string') throw new Error(`Cannot render template ${name}`);
      const render = globalThis.Shopware.Vue.compile(template, {
        ...component.adapter.app?.config.compilerOptions,
        onError(error) {
          throw error;
        },
      });
      renders.push({ component, template, render });
    }
    state.templates.set(id, next);
    for (const { component, template, render } of renders) {
      component.config.template = template;
      globalThis.__VUE_HMR_RUNTIME__.rerender(component.id, render);
    }
  } catch (error) {
    for (const [item, raw] of changed) item.raw = raw;
    clearTemplates();
    console.error('[Shopware HMR] Template update failed; fix the source and save again:', error);
  }
}
