import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { submitSnapshot, type Detector } from '@github/dependency-submission-toolkit';

import { loadLockfile } from './lockfile';
import { resolvePackages } from './parse';
import { buildManifest, buildSnapshot } from './snapshot';

// Read at runtime via require so the version tracks package.json without
// pulling the manifest into the TS program (it lives outside rootDir). ncc
// bundles the JSON at build time.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: ACTION_VERSION } = require('../package.json') as { version: string };

const DETECTOR: Detector = {
  name: 'bun-dependency-submission',
  url: 'https://github.com/pippinmole/bun-dependency-submission',
  version: ACTION_VERSION,
};

/** Compute a repo-root-relative POSIX path for the manifest `source_location`. */
export function manifestSourceLocation(workingDirectory: string, lockfileName: string): string {
  const rel = path.join(workingDirectory || '.', path.basename(lockfileName));
  return rel.split(path.sep).join('/').replace(/^\.\//, '');
}

export async function run(): Promise<void> {
  const workingDirectory = core.getInput('working-directory') || '.';
  const lockfileName = core.getInput('lockfile') || 'bun.lock';
  const dryRun = core.getBooleanInput('dry-run');
  const outputFileInput = core.getInput('output-file');

  core.info(`Reading lockfile "${lockfileName}" in "${workingDirectory}"`);
  const { data, format } = loadLockfile(workingDirectory, lockfileName);

  if (data.lockfileVersion !== undefined && data.lockfileVersion !== 1) {
    core.warning(
      `Unexpected lockfileVersion ${data.lockfileVersion} (this action was built for version 1). ` +
        'Parsing will be attempted but results may be incomplete.'
    );
  }

  const { resolved, stats } = resolvePackages(data);

  core.info(`Lockfile format: ${format}`);
  core.info(`Package entries scanned: ${stats.totalEntries}`);
  core.info(`Registry packages resolved: ${stats.resolved}`);
  core.info(`npm: aliases resolved to target: ${stats.aliasesResolved}`);
  core.info(`Non-registry entries skipped: ${stats.skipped}`);
  if (Object.keys(stats.skippedByProtocol).length > 0) {
    const breakdown = Object.entries(stats.skippedByProtocol)
      .map(([proto, count]) => `${proto} (${count})`)
      .join(', ');
    core.info(`  skipped by protocol: ${breakdown}`);
  }
  if (stats.invalid > 0) {
    core.warning(`${stats.invalid} package entries could not be parsed and were skipped.`);
  }

  if (resolved.length === 0) {
    core.warning('No registry packages resolved from the lockfile; submitting an empty snapshot.');
  }

  const sourceLocation = manifestSourceLocation(workingDirectory, lockfileName);
  const { manifest } = buildManifest(resolved, sourceLocation);
  const snapshot = buildSnapshot(manifest, { detector: DETECTOR, context: github.context });

  core.setOutput('resolved-count', String(resolved.length));
  core.setOutput('skipped-count', String(stats.skipped));
  core.setOutput('snapshot-json', snapshot.prettyJSON());

  if (dryRun) {
    const outFile = path.resolve(outputFileInput || 'bun-dependency-snapshot.json');
    fs.writeFileSync(outFile, snapshot.prettyJSON());
    core.info(`Dry run: snapshot written to ${outFile} (not submitted).`);
    core.setOutput('snapshot-file', outFile);
    return;
  }

  core.info(`Submitting snapshot with ${resolved.length} packages...`);
  await submitSnapshot(snapshot, github.context);
}

// Only auto-run when invoked as the action entrypoint, so the module can be
// imported in tests without side effects.
if (require.main === module) {
  run().catch((err: unknown) => {
    core.setFailed(err instanceof Error ? err.message : String(err));
  });
}
