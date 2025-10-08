function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMappings(map, { type, depth = 0 }) {
  const result = {};
  for (const [key, rawValue] of Object.entries(map)) {
    if (rawValue === '-' && depth === 0) {
      result[key] = type === 'input' ? `$.${key}` : key;
      continue;
    }

    if (isPlainObject(rawValue)) {
      result[key] = normalizeMappings(rawValue, { type, depth: depth + 1 });
      continue;
    }

    if (Array.isArray(rawValue)) {
      result[key] = rawValue.map((item) =>
        isPlainObject(item) ? normalizeMappings(item, { type, depth: depth + 1 }) : item
      );
      continue;
    }

    result[key] = rawValue;
  }
  return result;
}

function normalizeStep(step) {
  const normalized = { ...step };

  if (step.in && isPlainObject(step.in)) {
    normalized.in = normalizeMappings(step.in, { type: 'input' });
  }

  if (step.out && isPlainObject(step.out)) {
    normalized.out = normalizeMappings(step.out, { type: 'output' });
  }

  if (Array.isArray(step.children)) {
    normalized.children = step.children.map(normalizeStep);
  } else if (step.children && isPlainObject(step.children)) {
    const children = {};
    for (const [slot, value] of Object.entries(step.children)) {
      children[slot] = Array.isArray(value) ? value.map(normalizeStep) : value;
    }
    normalized.children = children;
  }

  return normalized;
}

export function normalizeCompose(compose) {
  if (!Array.isArray(compose)) return compose;
  return compose.map(normalizeStep);
}
