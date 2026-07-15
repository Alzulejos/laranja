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
