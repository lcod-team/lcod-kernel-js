export async function flowBreak() {
  const e = new Error('break');
  e.$signal = 'break';
  throw e;
}

