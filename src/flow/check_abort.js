export async function flowCheckAbort(ctx) {
  ctx.ensureNotCancelled();
  return {};
}
