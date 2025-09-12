# lcod-kernel-ts

Minimal TypeScript kernel to run **LCP** components:
- `axiom` (SDK primitives)
- `native` (existing implementation)
- `compose` (chaining child calls with explicit bindings)

Includes:
- JSON Schema validation for `inputSchema` / `outputSchema`
- Test runner (axiom mocks)
- Stable API: `Func(ctx, input) -> output`, `Registry`, `Context.call()`

## Quick demo

```bash
npm run demo   # runs the example composite (no deps required)

# Or run any compose.json
node bin/run-compose.mjs --compose ../lcod-spec/examples/demo/my_weather/compose.json --demo
```
