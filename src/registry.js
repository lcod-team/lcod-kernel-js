// Simple function registry and context

export class Registry {
  constructor() {
    this.funcs = new Map();
    this.bindings = {}; // contractId -> implId
  }
  register(name, fn, opts = {}) {
    const metadata = normalizeMetadata(opts.metadata);
    const outputs = normalizeOutputs(opts.outputs, metadata);
    const entry = {
      fn,
      inputSchema: opts.inputSchema,
      outputSchema: opts.outputSchema,
      implements: opts.implements,
      outputs,
      metadata
    };
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
    this._defaultRunSlot = this.runSlot;
    this._rawInputStack = [];
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

    const { fn, inputSchema, outputSchema, metadata } = entry;
    let preparedInput = dataIn ?? {};
    let rawSnapshot = null;
    if (metadata && metadata.inputs.length > 0) {
      const { sanitized, raw } = sanitizeComponentInput(preparedInput, metadata);
      preparedInput = sanitized;
      if (needsRawSnapshot(name)) {
        rawSnapshot = raw;
      }
    }
    const pushedRaw = Boolean(rawSnapshot);
    if (pushedRaw) {
      this._rawInputStack.push(rawSnapshot);
    }
    if (inputSchema) {
      const validate = await getValidator(inputSchema);
      const ok = validate(preparedInput);
      if (!ok) {
        const msg = (validate.errors || []).map(e => `${e.instancePath} ${e.message}`).join('; ');
        throw new Error(`Input validation failed for ${name}: ${msg}`);
      }
    }
    let out;
    try {
      out = await fn(this, preparedInput, meta);
    } finally {
      if (pushedRaw) {
        this._rawInputStack.pop();
      }
    }
    if (Array.isArray(entry.outputs) && entry.outputs.length > 0) {
      out = filterOutputs(out, entry.outputs);
    }
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

  currentRawInput() {
    if (!Array.isArray(this._rawInputStack) || this._rawInputStack.length === 0) {
      return null;
    }
    const snapshot = this._rawInputStack[this._rawInputStack.length - 1];
    return cloneJson(snapshot ?? null);
  }
}

function filterOutputs(state, outputs) {
  if (!outputs || outputs.length === 0) return state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const trimmed = {};
  for (const key of outputs) {
    trimmed[key] = Object.prototype.hasOwnProperty.call(state, key) ? state[key] : null;
  }
  return trimmed;
}

function normalizeOutputs(rawOutputs, metadata) {
  if (Array.isArray(rawOutputs) && rawOutputs.length > 0) {
    return dedupeStrings(rawOutputs);
  }
  if (metadata && metadata.outputs.length > 0) {
    return [...metadata.outputs];
  }
  return null;
}

function normalizeMetadata(meta) {
  if (!meta || typeof meta !== 'object') {
    return null;
  }
  const inputs = Array.isArray(meta.inputs) ? dedupeStrings(meta.inputs) : [];
  const outputs = Array.isArray(meta.outputs) ? dedupeStrings(meta.outputs) : [];
  const slots = Array.isArray(meta.slots) ? dedupeStrings(meta.slots) : [];
  if (!inputs.length && !outputs.length && !slots.length) {
    return null;
  }
  return { inputs, outputs, slots };
}

function dedupeStrings(list) {
  return [...new Set(list.filter((item) => typeof item === 'string' && item.length > 0))];
}

function toPlainObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return {};
  }
  return { value };
}

function sanitizeComponentInput(input, metadata) {
  const source = toPlainObject(input);
  if (!metadata || !metadata.inputs || metadata.inputs.length === 0) {
    return { sanitized: cloneJson(source), raw: null };
  }
  const rawSnapshot = cloneJson(source);
  const sanitized = {};
  for (const key of metadata.inputs) {
    sanitized[key] = Object.prototype.hasOwnProperty.call(source, key)
      ? cloneJson(source[key])
      : null;
  }
  return { sanitized, raw: rawSnapshot };
}

const RAW_SNAPSHOT_COMPONENTS = new Set(['lcod://tooling/sanitizer/probe@0.1.0']);

function needsRawSnapshot(name) {
  return RAW_SNAPSHOT_COMPONENTS.has(name);
}

function cloneJson(value, seen = new WeakMap()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const copy = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(cloneJson(item, seen));
    }
    return copy;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return seen.get(value);
    const out = {};
    seen.set(value, out);
    for (const [k, v] of Object.entries(value)) {
      out[k] = cloneJson(v, seen);
    }
    return out;
  }
  return value;
}
