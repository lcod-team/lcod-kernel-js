export function registerState(registry) {
  registry.register('lcod://axiom/state/raw_input@1', async (ctx) => {
    const snapshot = ctx.currentRawInput();
    return { value: snapshot };
  });
}
