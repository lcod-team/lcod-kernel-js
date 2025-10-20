function isTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function normalizeState(value) {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return cloneValue(value);
  }
  throw new Error(`flow/while: \`state\` must be an object, got ${typeof value}`);
}

function readMaxIterations(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || Math.floor(raw) !== raw) {
    throw new Error('flow/while: `maxIterations` must be a non-negative integer');
  }
  if (raw === 0) return null;
  return raw;
}

function interpretCondition(output) {
  if (output == null) {
    return { shouldContinue: false, stateOverride: null };
  }
  if (typeof output === 'object' && !Array.isArray(output)) {
    const stateOverride = output.state && typeof output.state === 'object' && !Array.isArray(output.state)
      ? cloneValue(output.state)
      : null;
    const candidate = output.continue ?? output.cond ?? output.value;
    if (candidate !== undefined) {
      return { shouldContinue: isTruthy(candidate), stateOverride };
    }
    if (Object.keys(output).length === 0) {
      return { shouldContinue: false, stateOverride };
    }
    throw new Error('flow/while: condition slot must return a boolean or an object with `continue`, `cond`, or `value`');
  }
  return { shouldContinue: isTruthy(output), stateOverride: null };
}

function cloneValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export async function flowWhile(ctx, input = {}) {
  let state = normalizeState(input.state);
  const maxIterations = readMaxIterations(input.maxIterations);
  let iterations = 0;

  while (true) {
    ctx.ensureNotCancelled();
    if (maxIterations != null && iterations >= maxIterations) {
      throw new Error(`flow/while: exceeded maxIterations limit (${maxIterations})`);
    }

    const slotVars = {
      index: iterations,
      state: cloneValue(state)
    };

    const conditionOutput = await ctx.runSlot('condition', cloneValue(state), slotVars);
    ctx.ensureNotCancelled();
    const { shouldContinue, stateOverride } = interpretCondition(conditionOutput);
    if (stateOverride) {
      state = stateOverride;
    }
    if (!shouldContinue) {
      break;
    }

    try {
      const bodyResult = await ctx.runSlot('body', cloneValue(state), slotVars);
      ctx.ensureNotCancelled();
      if (bodyResult == null) {
        // keep current state
      } else if (typeof bodyResult === 'object' && !Array.isArray(bodyResult)) {
        state = cloneValue(bodyResult);
      } else {
        throw new Error(`flow/while: body slot must return an object or null, got ${typeof bodyResult}`);
      }
    } catch (err) {
      if (err && err.$signal === 'continue') {
        iterations += 1;
        continue;
      }
      if (err && err.$signal === 'break') {
        iterations += 1;
        break;
      }
      throw err;
    }

    iterations += 1;
  }

  if (iterations === 0) {
    const elseVars = { index: -1, state: cloneValue(state) };
    const elseResult = await ctx.runSlot('else', cloneValue(state), elseVars);
    ctx.ensureNotCancelled();
    if (elseResult == null) {
      // nothing
    } else if (typeof elseResult === 'object' && !Array.isArray(elseResult)) {
      state = cloneValue(elseResult);
    } else {
      throw new Error(`flow/while: else slot must return an object or null, got ${typeof elseResult}`);
    }
  }

  return { state, iterations };
}
