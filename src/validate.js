// Optional JSON Schema validation using Ajv when available.
let ajvInstance = null;

async function loadAjv() {
  if (ajvInstance) return ajvInstance;
  try {
    const [{ default: Ajv }, { default: addFormats }] = await Promise.all([
      import('ajv'),
      import('ajv-formats').catch(() => ({ default: () => {} }))
    ]);
    const ajv = new Ajv({ strict: false, allErrors: true });
    if (addFormats) addFormats(ajv);
    ajvInstance = ajv;
  } catch {
    ajvInstance = null;
  }
  return ajvInstance;
}

const cache = new WeakMap();

export async function getValidator(schema) {
  const ajv = await loadAjv();
  if (!ajv) return Object.assign((/*data*/) => true, { errors: null });
  if (cache.has(schema)) return cache.get(schema);
  const validate = ajv.compile(schema);
  cache.set(schema, validate);
  return validate;
}
