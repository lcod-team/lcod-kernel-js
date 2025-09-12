// Simple function registry and context

export class Registry {
  constructor() { this.funcs = new Map(); }
  register(name, fn) { this.funcs.set(name, fn); return this; }
  get(name) { return this.funcs.get(name); }
}

export class Context {
  constructor(registry) { this.registry = registry; }
  async call(name, input) {
    const fn = this.registry.get(name);
    if (!fn) throw new Error(`Func not found: ${name}`);
    return await fn(this, input ?? {});
  }
}

