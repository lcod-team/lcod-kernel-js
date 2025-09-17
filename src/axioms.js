// Demo primitives to support the my_weather flow without external network.

export function registerDemoAxioms(reg) {
  // localisation: pretend GPS coordinates
  reg.register('lcod://core/localisation@1', async () => ({ gps: { lat: 48.8566, lon: 2.3522 } }));

  // extract_city from GPS: just return Paris for the mocked coords
  reg.register('lcod://core/extract_city@1', async (ctx, { gps }) => {
    if (!gps) throw new Error('missing gps');
    return { city: 'Paris' };
  });

  // weather by city: return a fixed temperature
  reg.register('lcod://core/weather@1', async (ctx, { city }) => {
    if (!city) throw new Error('missing city');
    return { tempC: 21 };
  });

  // simple echo implementation used by demos
  reg.register('lcod://impl/echo@1', async (_ctx, { value }) => ({ val: value }));

  // demo helper: predicate is_even
  reg.register('lcod://impl/is_even@1', async (_ctx, { value }) => ({ ok: (value % 2) === 0 }));

  // demo helper: predicate greater than limit
  reg.register('lcod://impl/gt@1', async (_ctx, { value, limit }) => ({ ok: value > limit }));

  return reg;
}
