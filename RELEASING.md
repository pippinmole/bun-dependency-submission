# Releasing

This document describes how a maintainer cuts a release of
**bun-dependency-submission**.

## Versioning model

The action follows the standard GitHub Action semver convention:

- **`vX.Y.Z`** — an immutable release tag pointing at one specific commit. Once
  pushed, it is never moved.
- **`vX`** — a moving **major alias** tag that always points at the newest
  `vX.*.*` release. Consumers pin to this so they receive backwards-compatible
  fixes automatically.

Consumers reference the action as `pippinmole/bun-dependency-submission@v1`.

Releases are **deliberate and manual**. Merging to `main` does **not** publish a
release — it only updates the source. A release happens only when a maintainer
pushes a `vX.Y.Z` tag.

## Pre-release checklist

- `npm run all` passes (format check, lint, typecheck, test, build).
- `dist/` is rebuilt and committed. The action runs from the committed `dist/`
  bundle, and CI **fails if `dist/` is out of date**, so the release commit must
  contain a current build.

## Cutting a release

From a clean checkout of `main`:

```bash
git checkout main && git pull
npm run all           # lint, typecheck, test, build

# Only if the build changed dist/:
git add dist && git commit -m "build: rebuild dist"

git tag v1.2.3
git push origin main --tags
```

## What the automation does

Pushing a `vX.Y.Z` tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. Force-updates the corresponding major alias tag (`v1.2.3` → `v1`) to point at
   the same commit and pushes it.
2. Creates (or updates) a GitHub Release for the exact `vX.Y.Z` tag with
   auto-generated notes.

The workflow is idempotent — re-running it on an existing release does not fail.

## How consumers pin

- **`@v1`** — tracks the latest `v1.*.*` release; picks up fixes automatically.
- **Full commit SHA** — fully immutable; recommended when reproducibility
  matters. Annotate it so readers know the version:

  ```yaml
  - uses: pippinmole/bun-dependency-submission@<40-char-sha> # v1.2.3
  ```
