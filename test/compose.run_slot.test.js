import test from 'node:test';
import assert from 'node:assert/strict';

import { composeRunSlot } from '../src/compose/run_slot.js';

test('compose/run_slot executes slot and returns result', async () => {
  let called = false;
  const ctx = {
    runSlot: async (_name, state) => {
      called = true;
      return { value: state?.value ?? 0 }; 
    }
  };
  const meta = { children: { target: [{}] } };
  const result = await composeRunSlot(ctx, { slot: 'target', state: { value: 99 } }, meta);
  assert.equal(called, true, 'slot should be invoked');
  assert.equal(result.ran, true);
  assert.equal(result.result.value, 99);
});

test('compose/run_slot optional flag skips missing slot', async () => {
  const ctx = {
    runSlot: async () => {
      throw new Error('should not run');
    }
  };
  const meta = { children: {} };
  const result = await composeRunSlot(ctx, { slot: 'missing', optional: true }, meta);
  assert.equal(result.ran, false);
  assert.equal(result.result, null);
});

test('compose/run_slot propagates slot errors in payload', async () => {
  const ctx = {
    runSlot: async () => { throw Object.assign(new Error('boom'), { code: 'X' }); }
  };
  const meta = { children: { target: [{}] } };
  const result = await composeRunSlot(ctx, { slot: 'target' }, meta);
  assert.equal(result.ran, true);
  assert.equal(result.error.code, 'X');
  assert.equal(result.error.message, 'boom');
});
