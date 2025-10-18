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
- Core primitives (`core/object`, `core/array`, `core/string`, `core/json`) to avoid falling back to `tooling/script@1`

## Quick demo

```bash
npm run demo   # runs the example composite (no deps required)

# Or run any compose.yaml (with optional demo axioms)
node bin/run-compose.mjs --compose ../lcod-spec/examples/demo/my_weather/compose.yaml --demo

# Options
# --demo       register built-in demo functions
# --modules    load functions from a JSON module map (id -> module/export)
# --state      provide initial state JSON file
# --resolver   register resolver axioms (implies --core) and enables:
#                --project <dir>     override projectPath (defaults to CWD)
#                --config <file>     pass resolve.config.json explicitly
#                --sources <file>    override sources.json (defaults to <project>/sources.json)
#                --output <file>     choose lcp.lock destination (defaults to <project>/lcp.lock)
#                --cache-dir <dir>   set LCOD_CACHE_DIR before execution
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
    "lcod://tooling/resolver@0.1.0": { "type": "path", "path": "../lcod-spec/examples/tooling/resolver" },
    "lcod://resolver/internal/load-descriptor@1": { "type": "path", "path": "../lcod-resolver/components/internal/load_descriptor" },
    "lcod://resolver/internal/load-config@1": { "type": "path", "path": "../lcod-resolver/components/internal/load_config" },
    "lcod://resolver/internal/lock-path@1": { "type": "path", "path": "../lcod-resolver/components/internal/lock_path" },
    "lcod://resolver/internal/build-lock@1": { "type": "path", "path": "../lcod-resolver/components/internal/build_lock" }
  }
}
JSON

npm run resolve -- --project ../lcod-spec/examples/demo/my_weather --config resolve.config.json
```

Set `LCOD_RESOLVER_PATH=/path/to/lcod-resolver` (or `LCOD_RESOLVER_COMPONENTS_PATH` directly) to let
the helper loader discover these components without explicit source overrides.

Mappings are optional; unresolved components emit warnings while still producing the lock stub.

## Run shared spec tests

The spec repository now stores reusable fixtures under `tests/spec`. To execute them against the Node kernel:

```bash
SPEC_REPO_PATH=/path/to/lcod-spec LCOD_SPEC_PATH=/path/to/lcod-spec npm run test:spec   # shared fixtures only
SPEC_REPO_PATH=/path/to/lcod-spec LCOD_SPEC_PATH=/path/to/lcod-spec npm run test:all    # internal tests + fixtures
```

Set `SPEC_REPO_PATH` (and `LCOD_SPEC_PATH` when running in CI) if the spec repository is not cloned next to the kernel. The same fixtures are consumed by the Rust kernel via `cargo run --bin test_specs`, keeping runtime behaviour aligned across substrates.

## Publish core Node axioms

Reusable contract implementations live under `packages/node-core-axioms`. To
refresh the distributable files before publishing, run:

```bash
npm run build:core-axioms
```

The generated package exposes `registerNodeCore(registry)` so other projects can
install the axiom bundle without pulling the entire kernel repository.
