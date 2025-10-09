# Roadmap — Node Kernel (lcod-kernel-js)

## M0 — Core runtime
- [x] Parse `lcp.toml` descriptors with strict TOML/JSON schema validation.
- [x] Register contracts, implementations and flow primitives in the in-memory registry.
- [x] Execute composite flows with scope resolution (`$`, `$slot.*`) and JSON Schema IO checks.

## M1 — Composition & tests
- [x] Flow operator set (`flow/if@1`, `flow/foreach@1`, `flow/parallel@1`, `flow/try@1`, `flow/throw@1`, `flow/break@1`, `flow/continue@1`).
- [x] Slot orchestration and async stream handling (`ctx.runChildren`, `ctx.runSlot`, loop control).
- [x] Regression coverage via `node --test`, shared spec fixtures (`npm run test:spec`) and CI workflows.

## M2 — Distribution & tooling
- [x] Strict validator CLI (`scripts/validate-lcp.mjs`) wired into CI.
- [x] Resolver prototype support (compose loader, lockfile-aware docs, `.lcpkg` route).
- [x] Compose normalisation hook to consume shared sugar (`tooling/compose/normalize@1`).

## M3 — Runtime parity

Goal: stay aligned with the spec and sibling substrates.

Delivered:
- [x] Core infrastructure contracts (filesystem, HTTP, Git, hashing, parsing) exposed via `registerNodeCore`.
- [x] Resolver integration: workspace helper discovery, canonical ID normalisation, resolver CLI (`bin/run-compose.mjs --resolver`).
- [x] Tooling contracts (`tooling/test_checker@1`, `tooling/script@1`) with sandboxed script execution.
- [x] Cross-runtime conformance harness (`npm run test:spec`, `node scripts/run-conformance.mjs` from lcod-spec).

Next:
- [ ] M3-06 Registry scope chaining: expose `tooling/registry/scope@1` and update the kernel to handle nested registries (compose → scope → parent) with dedicated tests.

## M4 — Observability & logging
- [ ] Implement the `lcod://tooling/log@1` contract once finalised in the spec (structured logging toward the host).
- [ ] Add a trace mode (`--trace`) to `bin/run-compose.mjs` to inspect scope mutations.

## M5 — Packaging & distribution
- [ ] Implement `--assemble` to bundle `lcp.lock` + `lcod_modules/`.
- [ ] Prototype `--ship` (kernel + launcher) and document embedding options.
- [ ] Explore `--build` targets (GraalVM/Node pkg) and record limitations.
