import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseBunLock,
  classifySpecifier,
  splitNameVersion,
  splitScope,
  resolvePackages,
  type ResolvedPackage,
} from '../src/parse';

function loadFixture(name: string) {
  const p = path.join(__dirname, 'fixtures', name, 'bun.lock');
  return parseBunLock(fs.readFileSync(p, 'utf8'));
}

function byKey(resolved: ResolvedPackage[]): Map<string, ResolvedPackage> {
  return new Map(resolved.map((r) => [r.key, r]));
}

test('splitNameVersion handles bare and scoped names', () => {
  assert.deepEqual(splitNameVersion('lodash@4.17.21'), { name: 'lodash', version: '4.17.21' });
  assert.deepEqual(splitNameVersion('@babel/core@7.23.0'), {
    name: '@babel/core',
    version: '7.23.0',
  });
  assert.equal(splitNameVersion('lodash'), null);
  assert.equal(splitNameVersion('@scope/only'), null);
});

test('splitScope separates npm scope from name', () => {
  assert.deepEqual(splitScope('@babel/core'), { namespace: '@babel', name: 'core' });
  assert.deepEqual(splitScope('lodash'), { namespace: null, name: 'lodash' });
});

test('classifySpecifier: registry, scoped, alias, protocols', () => {
  assert.deepEqual(classifySpecifier('lodash@4.17.21'), {
    kind: 'registry',
    name: 'lodash',
    version: '4.17.21',
    aliased: false,
  });
  assert.deepEqual(classifySpecifier('@babel/core@7.23.0'), {
    kind: 'registry',
    name: '@babel/core',
    version: '7.23.0',
    aliased: false,
  });
  // npm alias resolves to the real target
  assert.deepEqual(classifySpecifier('my-lodash@npm:lodash@4.17.21'), {
    kind: 'registry',
    name: 'lodash',
    version: '4.17.21',
    aliased: true,
  });
  assert.deepEqual(classifySpecifier('alias@npm:@scope/real@1.2.3'), {
    kind: 'registry',
    name: '@scope/real',
    version: '1.2.3',
    aliased: true,
  });
  // non-registry protocols are skipped
  assert.equal(classifySpecifier('@myorg/app@workspace:packages/app').kind, 'skip');
  assert.equal(classifySpecifier('local-lib@file:vendor/local-lib').kind, 'skip');
  assert.equal(classifySpecifier('forked@github:owner/repo#sha').kind, 'skip');
  assert.equal(classifySpecifier('x@https://example.com/x.tgz').kind, 'skip');
  assert.equal(classifySpecifier('x@link:../x').kind, 'skip');
  // invalid
  assert.equal(classifySpecifier('').kind, 'invalid');
  assert.equal(classifySpecifier(42).kind, 'invalid');
  assert.equal(classifySpecifier('bare-name').kind, 'invalid');
});

test('simple fixture: direct/dev classification and transitive edge', () => {
  const { resolved, stats } = resolvePackages(loadFixture('simple'));
  assert.equal(stats.resolved, 3);
  assert.equal(stats.skipped, 0);
  const m = byKey(resolved);

  const isOdd = m.get('is-odd@3.0.1')!;
  assert.equal(isOdd.relationship, 'direct');
  assert.equal(isOdd.scope, 'runtime');
  assert.deepEqual([...isOdd.edges], ['is-number@6.0.0']);

  const isNumber = m.get('is-number@6.0.0')!;
  assert.equal(isNumber.relationship, 'indirect');
  assert.equal(isNumber.scope, 'runtime');

  const leftPad = m.get('left-pad@1.3.0')!;
  assert.equal(leftPad.relationship, 'direct');
  assert.equal(leftPad.scope, 'development');
});

test('scoped fixture: scope namespaces preserved', () => {
  const { resolved, stats } = resolvePackages(loadFixture('scoped'));
  assert.equal(stats.resolved, 4);
  const m = byKey(resolved);

  const core = m.get('@babel/core@7.23.0')!;
  assert.equal(core.purlNamespace, '@babel');
  assert.equal(core.purlName, 'core');
  assert.equal(core.relationship, 'direct');
  assert.deepEqual([...core.edges], ['@babel/types@7.23.0']);

  const typesNode = m.get('@types/node@22.10.2')!;
  assert.equal(typesNode.scope, 'development');
  assert.deepEqual([...typesNode.edges], ['undici-types@6.20.0']);
});

test('monorepo fixture: workspace packages skipped, union of direct deps', () => {
  const { resolved, stats } = resolvePackages(loadFixture('monorepo'));
  assert.equal(stats.skipped, 2);
  assert.deepEqual(stats.skippedByProtocol, { 'workspace:': 2 });
  assert.equal(stats.resolved, 3);
  const m = byKey(resolved);

  // lodash (from packages/app) and ms (from packages/utils) are both direct
  assert.equal(m.get('lodash@4.17.21')!.relationship, 'direct');
  assert.equal(m.get('ms@2.1.3')!.relationship, 'direct');
  // typescript from root devDependencies
  assert.equal(m.get('typescript@5.7.2')!.relationship, 'direct');
  assert.equal(m.get('typescript@5.7.2')!.scope, 'development');
  // no workspace: internal packages leaked in
  assert.equal(
    [...m.keys()].some((k) => k.startsWith('@myorg/')),
    false
  );
});

test('protocols fixture: npm alias resolved, file/github skipped, patch kept', () => {
  const { resolved, stats } = resolvePackages(loadFixture('protocols'));
  assert.equal(stats.aliasesResolved, 1);
  assert.equal(stats.skipped, 2);
  assert.deepEqual(stats.skippedByProtocol, { 'file:': 1, 'github:': 1 });
  const m = byKey(resolved);

  // alias resolves to the real package AND is classified direct under its real name
  const lodash = m.get('lodash@4.17.21')!;
  assert.ok(lodash, 'aliased lodash should be present');
  assert.equal(lodash.relationship, 'direct');
  assert.equal(m.has('my-lodash@npm:lodash@4.17.21'), false);

  // patched dependency is still emitted as a normal registry package
  const isEven = m.get('is-even@1.0.0')!;
  assert.equal(isEven.relationship, 'direct');
  assert.deepEqual([...isEven.edges], ['is-odd@0.1.2']);
  assert.equal(m.get('is-odd@0.1.2')!.relationship, 'indirect');
  assert.equal(m.get('is-number@3.0.0')!.relationship, 'indirect');
});

test('empty fixture: no packages, no crash', () => {
  const { resolved, stats } = resolvePackages(loadFixture('empty'));
  assert.equal(resolved.length, 0);
  assert.equal(stats.resolved, 0);
  assert.equal(stats.skipped, 0);
});

test('parseBunLock tolerates trailing commas (JSONC)', () => {
  const data = parseBunLock(
    '{ "lockfileVersion": 1, "packages": { "a": ["a@1.0.0", "", {}, "sha"], }, }'
  );
  assert.equal(data.lockfileVersion, 1);
});
