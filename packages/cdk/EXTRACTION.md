# Extracting the synth moat to the server

`@laranja/cdk` is the **moat**: it turns an Infra IR into CloudFormation (`synth`,
`LaranjaStack`) and into editable CDK source (`generateEjectProject`, paid). To
keep it fork-proof it must run **server-side only** and never ship to a user's
machine. This is the guide for lifting it into the private backend repo.

No npm publish needed — the server consumes it as a git dependency or vendored
source.

## What moves vs. what stays

| File | Role | Lives where |
|------|------|-------------|
| `stack.ts` (`LaranjaStack`) | IR → CDK constructs | **server** |
| `synth.ts` (`synth`) | programmatic `App` → CloudFormation | **server** |
| `eject.ts` (`generateEjectProject`) | IR → standalone CDK project (paid) | **server** |
| `bundle.ts` (`bundleEntries`) | esbuild the Lambda code | **client (CLI)** — needs the user's source, so it can't move |

`bundle.ts` should be relocated to the CLI/runtime side; the server never sees code.

## Public API the server calls

```ts
synth(ir: InfraIR, handlers: BundledHandler[], opts: SynthOptions): SynthResult
generateEjectProject(ir: InfraIR, opts: EjectOptions): EjectedFile[]
```

- `/v1/synth` with `artifact: "cloudformation"` → `synth(...)` → return the template.
- `/v1/synth` with `artifact: "cdk"` → `generateEjectProject(...)` → return the files.

## Dependencies to resolve on lift

The moat imports:

- `@laranja/core` — `InfraIR`/`HttpIR` types **and** the value helpers
  `handlerLabel` / `handlerName`. Core is just types + contracts (no moat), so it
  can stay public/shared (git dep or small vendored copy).
- `@laranja/runtime` — only `generateEntries` (used by `eject.ts`) and the
  `GeneratedEntry` type. `generateEntries` is lightweight codegen (no heavy deps);
  the server needs it for eject, the client needs it for managed shims, so it's
  fine to share.
- `aws-cdk-lib`, `constructs` — normal npm deps of the server.
- `esbuild` — only used by `bundle.ts`; **drops off** the server once `bundle.ts`
  stays client-side.

## ⚠️ The asset seam (decide before building `/v1/synth`)

`synth()` currently takes `BundledHandler[]` whose `assetDir` points at
esbuild-bundled code **on disk**. The server has no code on disk — bundling is
client-side. So the server can't use CDK local assets as-is. Two options:

1. **`Code.fromBucket(bucket, key)`** (recommended): the **client** bundles, uploads
   each zip to the bootstrap/asset bucket at a deterministic key, and sends the
   `{ id → s3Key }` map in the synth request. The server synths a template that
   references those S3 locations. Cleanest decoupling; no CDK asset machinery
   server-side.
2. **Custom asset hash**: client computes each zip's content hash and sends it;
   server uses `Code.fromAsset(stub, { assetHash })`. Fiddlier (still needs a stage
   dir) — prefer option 1.

Either way, **`SynthRequest` will need to carry per-handler asset references**
(S3 keys or hashes) in addition to the IR. The current `SynthRequest` in
`@laranja/core/api.ts` only has the IR — extend it when wiring real deploys.

## Suggested private-repo layout

```
laranja-synth/            (private)
  src/stack.ts            (from packages/cdk)
  src/synth.ts
  src/eject.ts
  package.json            (aws-cdk-lib, constructs; core/runtime via git or vendored)
  tsconfig.json
```
