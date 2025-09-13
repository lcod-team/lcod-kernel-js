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

import { getValidator } from './validate.js';

export class Context {
  constructor(registry) { this.registry = registry; }
  async call(name, input) {
    let entry = this.registry.get(name);
    // Basic contract binding: if not found and looks like a contract ID, resolve via bindings
    if (!entry && typeof name === 'string' && name.startsWith('lcod://contract/')) {
      const implId = (this.registry.bindings || {})[name];
      if (!implId) throw new Error(`No binding for contract: ${name}`);
      entry = this.registry.get(implId);
      if (!entry) throw new Error(`Implementation not registered for ${name}: ${implId}`);
    }
    if (!entry) throw new Error(`Func not found: ${name}`);
    const { fn, inputSchema, outputSchema } = entry;
    const dataIn = input ?? {};
    if (inputSchema) {
      const validate = await getValidator(inputSchema);
      const ok = validate(dataIn);
      if (!ok) {
        const msg = (validate.errors || []).map(e => `${e.instancePath} ${e.message}`).join('; ');
        throw new Error(`Input validation failed for ${name}: ${msg}`);
      }
    }
    const out = await fn(this, dataIn);
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
}
