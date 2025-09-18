export async function flowThrow(_ctx, input = {}) {
  const message = typeof input.message === 'string' && input.message.length ? input.message : 'Flow throw';
  const code = typeof input.code === 'string' && input.code.length ? input.code : 'flow_throw';
  const error = new Error(message);
  error.code = code;
  if (Object.prototype.hasOwnProperty.call(input, 'data')) {
    error.data = input.data;
  }
  throw error;
}

