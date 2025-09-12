// Simple function registry and context

export class Registry {
  constructor() { this.funcs = new Map(); }
  register(name, fn, opts = {}) {
    const entry = { fn, inputSchema: opts.inputSchema, outputSchema: opts.outputSchema };
    this.funcs.set(name, entry);
    return this;
  }
  get(name) { return this.funcs.get(name); }
}

import { getValidator } from './validate.js';

export class Context {
  constructor(registry) { this.registry = registry; }
  async call(name, input) {
    const entry = this.registry.get(name);
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
