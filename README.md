# lcod-kernel-js

Minimal JavaScript/TypeScript kernel to run **LCP** components:
- `axiom` (SDK primitives)
- `native` (existing implementation)
- `compose` (chaining child calls with explicit bindings)

Includes:
- JSON Schema validation for `inputSchema` / `outputSchema`
- Test runner (axiom mocks)
- Stable API: `Func(ctx, input) -> output`, `Registry`, `Context.call()`
- Flow operators: `if`, `foreach`, `parallel`, `try/throw`, plus `continue`/`break`

## Quick demo

```bash
npm run demo   # runs the example composite (no deps required)

# Or run any compose.yaml (with optional demo axioms)
node bin/run-compose.mjs --compose ../lcod-spec/examples/demo/my_weather/compose.yaml --demo

# Options
# --demo       register built-in demo functions
# --modules    load functions from a JSON module map (id -> module/export)
# --state      provide initial state JSON file
```

## Validate a component package

Use the strict validator (Ajv 2020 + @iarna/toml) to lint an LCP package before running it:

```bash
# Validate the foreach control demo from lcod-spec
npm run validate:lcp -- ../lcod-spec/examples/flow/foreach_ctrl_demo

# Validate a package pointed directly at lcp.toml
npm run validate:lcp -- ./packages/weather-widget/lcp.toml
```

The script checks:
- `lcp.toml` structure against `schema/lcp.schema.json`
- Presence and JSON validity of referenced `tool.*` and `ui.propsSchema`
- Presence of docs assets (README/logo when declared)

## Resolve dependencies (prototype)

Create a `resolve.config.json` with source mappings and generate a lockfile:

```bash
cat > resolve.config.json <<'JSON'
{
  "sources": {
    "lcod://tooling/resolver@0.1.0": { "type": "path", "path": "../lcod-spec/examples/tooling/resolver" }
  }
}
JSON

npm run resolve -- --project ../lcod-spec/examples/demo/my_weather --config resolve.config.json
```

Mappings are optional; unresolved components emit warnings while still producing the lock stub.

## Run shared spec tests

The spec repository now stores reusable fixtures under `tests/spec`. To execute them against the Node kernel:

```bash
npm run test:spec   # uniquement les fixtures partagées
npm run test:all    # tests internes + fixtures spec
```

Set `SPEC_REPO_PATH=/path/to/lcod-spec` to override the auto-detected location. The same fixtures are consumed by the Rust kernel via `cargo run --bin test_specs`, keeping runtime behaviour aligned across substrates.

## Publish core Node axioms

Reusable contract implementations live under `packages/node-core-axioms`. To
refresh the distributable files before publishing, run:

```bash
npm run build:core-axioms
```

The generated package exposes `registerNodeCore(registry)` so other projects can
install the axiom bundle without pulling the entire kernel repository.
