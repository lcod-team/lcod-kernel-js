# Roadmap — lcod-kernel-ts

## M0 — Execution
- TOML loader for `lcp.toml` + JSON companion files
- Implement `compose`, `axiom`, `native`
- `${var}` interpolation + `$.x` memory lookups
- IO validation (JSON Schema)

## M1 — Tests & SDK
- Axiom mocks (`http.get`, `gps.read`) + test runner
- Hints/policies (timeout, retry)
- Basic logging/tracing

## M2 — Embedding & adapters
- Library export (`runComponent(id, input, opts)`)
- Tiny HTTP adapter (Express) and JSON-RPC (MCP-like)
- Read-only `.lcpkg` execution (offline cache)
