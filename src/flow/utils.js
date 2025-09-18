export function getByPath(rootObj, pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return pathStr;
  const parts = pathStr.split('.');
  let current = rootObj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

export function normalizeError(err) {
  if (err && typeof err === 'object' && err.$signal) {
    throw err; // propagate flow control (continue/break)
  }
  if (err && typeof err === 'object') {
    const message = typeof err.message === 'string' && err.message.length
      ? err.message
      : 'Unexpected error';
    const code = typeof err.code === 'string' && err.code.length
      ? err.code
      : 'unexpected_error';
    const data = Object.prototype.hasOwnProperty.call(err, 'data') ? err.data : undefined;
    const normalized = { code, message };
    if (data !== undefined) normalized.data = data;
    return normalized;
  }
  const message = typeof err === 'string' ? err : 'Unexpected error';
  return { code: 'unexpected_error', message };
}

