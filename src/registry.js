// Simple function registry and context

export class Registry {
  constructor() {
    this.funcs = new Map();
    this.bindings = {}; // contractId -> implId
  }
  register(name, fn, opts = {}) {
    const entry = { fn, inputSchema: opts.inputSchema, outputSchema: opts.outputSchema, implements: opts.implements };
    this.funcs.set(name, entry);
    return this;
  }
  setBindings(map) { this.bindings = { ...(this.bindings || {}), ...(map || {}) }; }
  get(name) { return this.funcs.get(name); }
}

export function createCancellationToken() {
  const state = { cancelled: false };
  return {
    cancel() { state.cancelled = true; },
    isCancelled() { return state.cancelled; }
  };
}

export class ExecutionCancelledError extends Error {
  constructor(message = 'Execution cancelled') {
    super(message);
    this.name = 'ExecutionCancelledError';
  }
}

import { getValidator } from './validate.js';
import { StreamManager } from './core/streams.js';

export class Context {
  constructor(registry, options = {}) {
    this.registry = registry;
    this.streams = new StreamManager();
    this.runChildren = async (_childrenArray, _localState, _slotVars) => { throw new Error('runChildren not available in this context'); };
    this.runSlot = async (_slotName, _localState, _slotVars) => { throw new Error('runSlot not available in this context'); };
    // Cleanup scopes for resources
    this._scopeStack = [];
    this._registryScopeStack = [];
    this._skipRegistryReady = Boolean(options.skipRegistryReady);
    this._cancellation = options.cancellation || createCancellationToken();
  }
  cancellationToken() { return this._cancellation; }
  cancel() {
    if (this._cancellation && typeof this._cancellation.cancel === 'function') {
      this._cancellation.cancel();
    }
  }
  isCancelled() {
    return Boolean(this._cancellation && typeof this._cancellation.isCancelled === 'function' && this._cancellation.isCancelled());
  }
  ensureNotCancelled() {
    if (this.isCancelled()) {
      throw new ExecutionCancelledError();
    }
  }
  defer(fn) {
    if (!this._scopeStack.length) this._scopeStack.push([]);
    this._scopeStack[this._scopeStack.length - 1].push(fn);
  }
  _pushScope() { this._scopeStack.push([]); }
  async _popScope() {
    const list = this._scopeStack.pop() || [];
    for (let i = list.length - 1; i >= 0; i--) {
      try { await list[i](); } catch (_e) { /* ignore cleanup errors */ }
    }
  }
  async call(name, input, meta) {
    this.ensureNotCancelled();
    const dataIn = input ?? {};

    const awaitRegistryReady = async () => {
      if (this._skipRegistryReady) return;
      const ready = this.registry?.__toolingReady;
      if (!ready || typeof ready.then !== 'function') return;
      await ready;
    };

    let entry = this.registry.get(name);
    if (!entry) {
      await awaitRegistryReady();
      entry = this.registry.get(name);
    }
    if (!entry && typeof name === 'string' && name.startsWith('lcod://contract/')) {
      const implId = (this.registry.bindings || {})[name];
      if (implId && implId !== name) {
        entry = this.registry.get(implId);
        if (!entry) {
          await awaitRegistryReady();
          entry = this.registry.get(implId);
        }
        if (!entry) {
          throw new Error(`Implementation not registered for ${name}: ${implId}`);
        }
      } else if (!implId) {
        throw new Error(`No binding for contract: ${name}`);
      }
    }

    if (!entry) {
      if (!this._skipRegistryReady) {
        const ready = this.registry?.__toolingReady;
        if (ready && typeof ready.catch === 'function') {
          const err = await ready.then(() => null).catch((error) => error);
          if (err) throw err;
        }
      }
      throw new Error(`Func not found: ${name}`);
    }

    const { fn, inputSchema, outputSchema } = entry;
    if (inputSchema) {
      const validate = await getValidator(inputSchema);
      const ok = validate(dataIn);
      if (!ok) {
        const msg = (validate.errors || []).map(e => `${e.instancePath} ${e.message}`).join('; ');
        throw new Error(`Input validation failed for ${name}: ${msg}`);
      }
    }
    const out = await fn(this, dataIn, meta);
    if (outputSchema) {
      const validate = await getValidator(outputSchema);
      const ok = validate(out);
      if (!ok) {
        const msg = (validate.errors || []).map(e => `${e.instancePath} ${e.message}`).join('; ');
        throw new Error(`Output validation failed for ${name}: ${msg}`);
      }
    }
    return out;
  }

  enterRegistryScope(options = {}) {
    const snapshot = {
      bindings: { ...(this.registry.bindings || {}) },
      funcs: this.registry.funcs
    };
    this._registryScopeStack.push(snapshot);

    const merged = { ...snapshot.bindings };
    if (options && typeof options.bindings === 'object' && options.bindings !== null) {
      for (const [contractId, implementationId] of Object.entries(options.bindings)) {
        if (typeof contractId === 'string' && typeof implementationId === 'string') {
          merged[contractId] = implementationId;
        }
      }
    }
    this.registry.bindings = merged;
    this.registry.funcs = new Map(this.registry.funcs);
  }

  leaveRegistryScope() {
    const previous = this._registryScopeStack.pop();
    if (previous) {
      this.registry.bindings = previous.bindings;
      this.registry.funcs = previous.funcs;
    } else {
      this.registry.bindings = {};
      if (!(this.registry.funcs instanceof Map)) {
        this.registry.funcs = new Map();
      }
    }
  }
}
