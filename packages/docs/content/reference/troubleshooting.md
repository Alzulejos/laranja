---
title: Troubleshooting
description: Known issues and their fixes.
order: 9
---

# Troubleshooting

Known issues you might hit, and how to resolve them.

## NestJS: webpack builder

**Symptom.** Deploy fails resolving your app's entry — e.g. it looks for the
`bootstrap` function but can't find it, or complains about a `bootstrap2` /
`__FUNCTION__` export. Opening the compiled `main.js` shows the bootstrap function
renamed and re-exported at the bottom of the file.

**Cause.** Nest can build with either the `tsc` builder (the default) or **webpack**.
laranja packages your compiled output and resolves the exported bootstrap function
**by name**. The webpack builder bundles your whole app into one file and
scope-hoists / renames identifiers, so `bootstrap` becomes something like
`bootstrap2` and the module's top-level export is emitted as a synthetic
`__FUNCTION__` — the name laranja looks for no longer exists.

**Fix.** Use the `tsc` builder (Nest's default). It mirrors each source file 1:1 and
keeps the export intact.

- Remove the webpack builder from `nest-cli.json`:

  ```jsonc
  // nest-cli.json — remove any of these under compilerOptions:
  {
    "compilerOptions": {
      "webpack": true,               // ← remove
      "builder": "webpack"           // ← remove
    }
  }
  ```

- Remove `--webpack` from your build script (e.g. `nest build --webpack` →
  `nest build`).

`laranja plan` warns when it detects the webpack builder in `nest-cli.json`, so you
can catch this before deploying.

## Azure: publish fails with a storage `403` right after `destroy`

**Symptom.** On Azure, a deploy provisions fine but the **publish** step fails with:

```
Package publish failed: InaccessibleStorageException: … BlobUploadFailedException:
… 403 (This request is not authorized to perform this operation using this permission.)
```

It usually happens right after a `destroy` + `deploy`, and a second `deploy` a few
minutes later just works.

**Cause.** A `destroy` deletes the Function App **and its managed identity**; the next
`deploy` creates a **brand-new identity**. laranja grants that identity access to the
storage account in the ARM deployment (control plane, seconds), but Azure's **storage
data plane takes several minutes to honor a new role assignment**. Publishing your code
happens immediately after provisioning, so on a fresh identity it can **race ahead of
propagation** and get a `403`. It's transient, not a misconfiguration.

**Fix.** laranja now **retries the publish through the propagation window**
automatically (with backoff), so a fresh deploy waits it out instead of failing. If you
see this on an older CLI, either:

- **just run `laranja deploy` again** in a few minutes — provisioning is idempotent and
  the identity will have propagated, or
- **avoid `destroy` + `deploy` while iterating** — a plain redeploy keeps the same
  identity, so there's no new role to propagate and no race.

The same "brand-new identity is still propagating" effect can briefly delay **logs**
after a `destroy` (App Insights ingestion uses the identity too) — give it a few minutes
and they appear.
