export async function localisation() {
  return { gps: { lat: 48.8566, lon: 2.3522 } };
}

export async function extract_city(_ctx, { gps }) {
  if (!gps) throw new Error('missing gps');
  return { city: 'Paris' };
}

export async function weather(_ctx, { city }) {
  if (!city) throw new Error('missing city');
  return { tempC: 21 };
}

