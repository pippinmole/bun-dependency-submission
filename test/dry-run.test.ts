import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Drives the full action entrypoint in dry-run mode. Environment (both the
 * GITHUB_* context and INPUT_* action inputs) must be set before `@actions/github`
 * is first imported, so `src/index` is loaded dynamically inside the test.
 */
test('run() in dry-run mode writes a valid snapshot without submitting', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-dep-sub-'));
  const outFile = path.join(tmp, 'snapshot.json');
  const outputsFile = path.join(tmp, 'gh-output');
  fs.writeFileSync(outputsFile, '');
  // Relative to the repo root (npm test runs from there), mirroring how a real
  // workflow passes a repo-relative working-directory.
  const workingDirectory = 'test/fixtures/simple';
  const fixtureDir = path.resolve(process.cwd(), workingDirectory);

  // GitHub context
  process.env.GITHUB_SHA = '0'.repeat(40);
  process.env.GITHUB_REF = 'refs/heads/main';
  process.env.GITHUB_EVENT_NAME = 'push';
  process.env.GITHUB_JOB = 'submit';
  process.env.GITHUB_RUN_ID = '42';
  process.env.GITHUB_REPOSITORY = 'octocat/example';
  process.env.GITHUB_WORKSPACE = fixtureDir;
  process.env.GITHUB_OUTPUT = outputsFile;

  // Action inputs
  process.env['INPUT_WORKING-DIRECTORY'] = workingDirectory;
  process.env['INPUT_LOCKFILE'] = 'bun.lock';
  process.env['INPUT_DRY-RUN'] = 'true';
  process.env['INPUT_OUTPUT-FILE'] = outFile;

  const { run } = await import('../src/index');
  await run();

  assert.ok(fs.existsSync(outFile), 'snapshot file should be written');
  const snapshot = JSON.parse(fs.readFileSync(outFile, 'utf8'));

  assert.equal(snapshot.version, 0);
  assert.equal(snapshot.sha, '0'.repeat(40));
  assert.equal(snapshot.ref, 'refs/heads/main');
  assert.equal(snapshot.detector.name, 'bun-dependency-submission');
  assert.equal(snapshot.job.correlator, 'submit');

  const manifest = snapshot.manifests['test/fixtures/simple/bun.lock'];
  assert.ok(manifest, 'snapshot should contain the bun.lock manifest');
  const resolved = manifest.resolved;
  assert.equal(Object.keys(resolved).length, 3);
  assert.equal(resolved['pkg:npm/is-odd@3.0.1'].relationship, 'direct');
  assert.deepEqual(resolved['pkg:npm/is-odd@3.0.1'].dependencies, ['pkg:npm/is-number@6.0.0']);
});
