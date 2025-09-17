export async function flowContinue() {
  const e = new Error('continue');
  e.$signal = 'continue';
  throw e;
}

