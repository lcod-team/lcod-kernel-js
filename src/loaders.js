import fs from 'node:fs';
import path from 'node:path';

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function pathToFileUrl(p) {
  const u = new URL('file:');
  u.pathname = p.split(path.sep).map(encodeURIComponent).join('/');
  if (process.platform === 'win32' && !u.pathname.startsWith('/')) u.pathname = '/' + u.pathname;
  return u;
}

export async function loadModulesFromMap(reg, mapPath, { baseDir = process.cwd() } = {}) {
  const abs = path.resolve(baseDir, mapPath);
  const cfg = readJson(abs);
  for (const [id, entry] of Object.entries(cfg)) {
    if (typeof entry === 'string') {
      const mod = await import(pathToFileUrl(path.resolve(baseDir, entry)).href);
      const fn = mod.default || mod[id.split('/').slice(-1)[0]];
      if (!fn) throw new Error(`Export not found for ${id} in ${entry}`);
      reg.register(id, fn);
      continue;
    }
    const modPath = path.resolve(baseDir, entry.module);
    const exp = entry.export || 'default';
    const mod = await import(pathToFileUrl(modPath).href);
    const fn = mod[exp];
    if (!fn) throw new Error(`Export ${exp} not found in ${entry.module}`);
    let opts = {};
    if (entry.inputSchemaPath) opts.inputSchema = readJson(path.resolve(baseDir, entry.inputSchemaPath));
    if (entry.outputSchemaPath) opts.outputSchema = readJson(path.resolve(baseDir, entry.outputSchemaPath));
    if (entry.inputSchema) opts.inputSchema = entry.inputSchema;
    if (entry.outputSchema) opts.outputSchema = entry.outputSchema;
    reg.register(id, fn, opts);
  }
  return reg;
}

