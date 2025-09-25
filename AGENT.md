# AGENT — lcod-kernel-js

## Mission
Deliver a minimal TS kernel compliant with LCP, executable without real network.

## Constraints
- Strict TypeScript; avoid fragile string templating for codegen.
- No real HTTP in tests (mocks only).
- Stable API: `Func`, `Registry`, `Context`.

## Definition of Done
- `npm test` passes (incl. `my_weather` example)
- `npm run demo` shows a working composed flow
- README documents the public API
