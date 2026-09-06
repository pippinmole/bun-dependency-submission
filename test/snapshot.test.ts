import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseBunLock, resolvePackages } from '../src/parse';
import { buildManifest } from '../src/snapshot';

function loadFixture(name: string) {
  const p = path.join(__dirname, 'fixtures', name, 'bun.lock');
  return parseBunLock(fs.readFileSync(p, 'utf8'));
}

/** Serialize a manifest the way the Snapshot API would (via Dependency.toJSON). */
function resolvedJson(name: string, manifestName = 'bun.lock') {
  const { resolved } = resolvePackages(loadFixture(name));
  const { manifest } = buildManifest(resolved, manifestName);
  return JSON.parse(JSON.stringify(manifest.resolved)) as Record<
    string,
    { package_url: string; relationship: string; scope: string; dependencies: string[] }
  >;
}

test('scoped PURLs percent-encode the leading @ of the namespace', () => {
  const resolved = resolvedJson('scoped');
  const keys = Object.keys(resolved);
  assert.ok(keys.includes('pkg:npm/%40babel/core@7.23.0'), `keys: ${keys.join(', ')}`);
  assert.ok(keys.includes('pkg:npm/%40babel/types@7.23.0'));
  assert.equal(
    resolved['pkg:npm/%40babel/core@7.23.0']!.package_url,
    'pkg:npm/%40babel/core@7.23.0'
  );
});

test('simple manifest: relationship, scope, and dependency edges serialize correctly', () => {
  const resolved = resolvedJson('simple');
  const isOdd = resolved['pkg:npm/is-odd@3.0.1']!;
  assert.equal(isOdd.relationship, 'direct');
  assert.equal(isOdd.scope, 'runtime');
  assert.deepEqual(isOdd.dependencies, ['pkg:npm/is-number@6.0.0']);

  const leftPad = resolved['pkg:npm/left-pad@1.3.0']!;
  assert.equal(leftPad.relationship, 'direct');
  assert.equal(leftPad.scope, 'development');
  assert.deepEqual(leftPad.dependencies, []);

  const isNumber = resolved['pkg:npm/is-number@6.0.0']!;
  assert.equal(isNumber.relationship, 'indirect');
});

test('protocols manifest: aliased package emitted under real PURL, skips absent', () => {
  const resolved = resolvedJson('protocols');
  const keys = Object.keys(resolved);
  assert.ok(keys.includes('pkg:npm/lodash@4.17.21'));
  assert.equal(resolved['pkg:npm/lodash@4.17.21']!.relationship, 'direct');
  // no file:/github: packages leak into the snapshot
  assert.equal(
    keys.some((k) => k.includes('local-lib') || k.includes('forked-dep')),
    false
  );
});

test('empty manifest serializes to an empty resolved map', () => {
  const resolved = resolvedJson('empty');
  assert.deepEqual(resolved, {});
});

test('manifest name/source_location is set from the lockfile path', () => {
  const { resolved } = resolvePackages(loadFixture('simple'));
  const { manifest } = buildManifest(resolved, 'apps/web/bun.lock');
  assert.equal(manifest.name, 'apps/web/bun.lock');
  const json = JSON.parse(JSON.stringify(manifest)) as {
    name: string;
    file: { source_location: string };
  };
  assert.equal(json.file.source_location, 'apps/web/bun.lock');
});
