# Bun Dependency Submission

A GitHub Action that parses a **Bun lockfile (`bun.lock`)** and submits the full
resolved dependency tree — direct **and transitive** — to GitHub's
[Dependency Submission API](https://docs.github.com/en/rest/dependency-graph/dependency-submission).
This makes your Bun project's dependencies visible in the **dependency graph**,
so they are matched against the **GitHub Advisory Database** and surface as
**Dependabot alerts** in your repository's Security tab.

> **Community-maintained. Not affiliated with GitHub or Bun.**

## Why this exists

GitHub's dependency graph natively parses `package-lock.json`, `yarn.lock`, and
`pnpm-lock.yaml` — but [**not** `bun.lock`](https://docs.github.com/en/code-security/reference/supply-chain-security/dependency-graph-supported-package-ecosystems).
As a result, repositories that use Bun get **no transitive-dependency
visibility** in the graph, and therefore **no Dependabot security alerts** for
vulnerabilities buried in their dependency tree.

Dependabot _version updates_ do support Bun (`bun`, ≥ 1.1.39), but that is a
separate mechanism: it opens "keep dependencies current" PRs and does **not**
populate the dependency graph, and Dependabot _security updates_ are
[not supported for Bun](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories).

This action closes that gap by reading `bun.lock` directly and submitting a
snapshot of every resolved registry package.

## Quick start

Create `.github/workflows/dependency-submission.yml`:

```yaml
name: Bun Dependency Submission

on:
  push:
    branches: [main] # your default branch
  schedule:
    - cron: '0 6 * * 1' # weekly, so alerts track new advisories
  workflow_dispatch:

# Required: the action needs write access to submit the snapshot.
permissions:
  contents: write

jobs:
  submit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pippinmole/bun-dependency-submission@v1
```

That's it. On the next run, open **Insights → Dependency graph** and
**Security → Dependabot** to see your Bun dependencies and any alerts.

> **Why `schedule:`?** A snapshot reflects your tree at one commit. New
> advisories are published continuously, so a weekly run re-submits the same
> tree and lets GitHub re-evaluate it against the latest advisory data even when
> your lockfile hasn't changed.

## Inputs

| Input               | Default               | Description                                                                                         |
| ------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `working-directory` | `.`                   | Directory containing the lockfile, relative to the repo root.                                       |
| `lockfile`          | `bun.lock`            | Lockfile filename. Use `bun.lock` (text) or `bun.lockb` (legacy binary — requires `bun` on `PATH`). |
| `dry-run`           | `false`               | When `true`, write the snapshot to a file instead of submitting it.                                 |
| `output-file`       | _(unset)_             | Where to write the snapshot when `dry-run` is `true`. Defaults to `bun-dependency-snapshot.json`.   |
| `token`             | `${{ github.token }}` | Token used to submit the snapshot. Needs `contents: write`.                                         |

## Outputs

| Output           | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `resolved-count` | Number of registry packages included in the snapshot. |
| `skipped-count`  | Number of non-registry entries skipped.               |
| `snapshot-file`  | Path the snapshot was written to (dry-run only).      |
| `snapshot-json`  | The generated snapshot as a JSON string.              |

## Monorepos & workspaces

A Bun workspace repo has a single `bun.lock` at the root that resolves every
workspace's dependencies. The default configuration handles it — the action
reads the root lockfile and submits one manifest containing the full tree.
Internal `workspace:` packages are skipped (they aren't registry packages);
everything they pull from the registry is included.

If your lockfile lives in a subdirectory, set `working-directory`:

```yaml
- uses: pippinmole/bun-dependency-submission@v1
  with:
    working-directory: apps/api
```

## Legacy binary lockfiles (`bun.lockb`)

The binary format is read by shelling out to `bun`, so add
[`oven-sh/setup-bun`](https://github.com/oven-sh/setup-bun) before this step:

```yaml
- uses: actions/checkout@v4
- uses: oven-sh/setup-bun@v2
- uses: pippinmole/bun-dependency-submission@v1
  with:
    lockfile: bun.lockb
```

Migrating to the text lockfile (`bun install --save-text-lockfile`) is
recommended — it diffs cleanly and needs no extra setup.

## Local verification (dry run)

Run the action in `dry-run` mode to inspect the snapshot without submitting:

```yaml
- uses: pippinmole/bun-dependency-submission@v1
  with:
    dry-run: true
    output-file: snapshot.json
```

## What gets submitted

- **Registry packages** are mapped to Package URLs: `pkg:npm/<name>@<version>`.
  Scoped names are percent-encoded (`@babel/core` → `pkg:npm/%40babel/core@...`).
- **`npm:` aliases** (`"foo": "npm:bar@1.2.3"`) are resolved to their real
  target (`pkg:npm/bar@1.2.3`) so advisories match the package actually installed.
- **Relationship** — `direct` if declared by any workspace, otherwise `indirect`.
- **Scope** — `development` if declared only in `devDependencies`, else `runtime`.
- **Skipped** (not registry packages, so not submittable): `workspace:`,
  `link:`, `file:`, `git`/`github:`, `http(s):`, `catalog:`, `jsr:`.
- **Patched dependencies** are submitted as their underlying registry package.

## Requirements & caveats

- **Dependency graph must be enabled.** It is on by default for public repos.
  For private repos it requires the dependency graph / GitHub Advanced Security
  to be enabled in the repository's security settings.
- **`permissions: contents: write`** is required for the token to submit.
- **This is not a code scanner.** It makes Bun's dependencies _visible_ to
  GitHub's existing advisory matching; it does not itself detect vulnerabilities.
- **Lockfile format may change.** This action targets `bun.lock`
  **lockfileVersion 1**. If Bun bumps the format, parsing may need updating (the
  action warns on an unexpected version).
- **First-party support may obsolete this.** If GitHub or Bun ship native
  `bun.lock` dependency-graph support, prefer that and retire this action.

## Alternatives

- **[`anchore/sbom-action`](https://github.com/anchore/sbom-action)** — as of
  Syft 1.46.0 its JavaScript cataloger parses `bun.lock`. It produces an **SBOM**
  (SPDX/CycloneDX) for third-party scanners; it does **not** submit to GitHub's
  dependency graph, so it won't produce native Dependabot alerts on its own.
- **Dependabot `bun` ecosystem** — native _version-update_ PRs for Bun, but no
  dependency-graph population and no security updates.

## Development

```bash
npm install
npm run format      # oxfmt (write)
npm run lint        # oxlint
npm run typecheck   # tsc --noEmit
npm test            # node --test (tsx)
npm run build       # bundle to dist/ with @vercel/ncc
npm run all         # everything above
```

The action runs from the committed **`dist/`** bundle, so rebuild and commit
`dist/` whenever you change `src/`. CI fails if `dist/` is out of date.

### Releasing

Releases are cut deliberately by pushing a `vX.Y.Z` tag; a major alias (`vX`)
tracks the latest release for consumers. See [RELEASING.md](./RELEASING.md) for
the full process.

## License

[MIT](./LICENSE)
