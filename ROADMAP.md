# Roadmap — Node Kernel (lcod-kernel-js)

## M0 — Core format
- [x] Load `lcp.toml` descriptors with strict TOML/JSON parsing and schema validation.
- [x] Register contracts, implementations and flow primitives in the registry.
- [x] Execute composite flows with scope resolution (`$`, `$slot.*`) and JSON Schema IO checks.

## M1 — Composition & tests
- [x] Ship the flow operator set (`flow/if@1`, `flow/foreach@1`, `flow/parallel@1`, `flow/try@1`, `flow/throw@1`, `flow/break@1`, `flow/continue@1`).
- [x] Restore slot helpers for nested flows and support async stream collection + loop control.
- [x] Provide regression coverage via `node --test` (`test/flow.blocks.test.js`) and the "Node Tests" GitHub Action.

## M2 — Distribution & security
- [x] Expose the strict validator CLI (`scripts/validate-lcp.mjs`) and wire it into CI.
- [x] Support `compose.yaml`, resolver prototype (`scripts/resolve.mjs`), and lockfile-aware docs.
- [x] Integrate with the packaging pipeline (lockfile generation + `.lcpkg` archives).

## M3 — Runtime substrates
- [x] M3-01: Consume the spec infrastructure contracts (filesystem, HTTP, Git, hashing, TOML/JSON parsing) in the runtime registry.
- [ ] M3-02: Publish a Node axiom bundle implementing the M3 contract set (npm package + docs).
- [ ] M3-03: Execute the resolver composite with the Node axiom bundle and verify lockfile production end-to-end.
- [ ] M3-04: Define substrate boundaries so additional runtimes (Rust, Java, …) can plug in; document the Node reference implementation.
- [ ] M3-05: Build a conformance harness comparing Node results against future substrates.
  - [x] Consume spec `tooling/test_checker@1` fixtures from CI and expose `npm run test:spec`
  - [x] Implement `tooling/script@1` runtime support (Node `vm` sandbox)
- [ ] M3-06: Expose the embedded scripting sandbox API (`$api.run`, `$api.config`) with configurable sandboxing.

## M4 — Packaging pipeline
- [ ] Implement CLI support for `--assemble` to bundle `lcp.lock` + `lcod_modules/` (Node compose + deps).
- [ ] Prototype `--ship` (kernel + launcher) and document runtime embedding options.
- [ ] Explore `--build` targets (Node pkg/GraalVM or other distribution tooling) and record limitations.
- [ ] Consommer le composant partagé `tooling/compose/normalize@1` pour gérer la syntaxe sugar côté loader avant d'exécuter le compose canonique.
