import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';

/** A single workspace's declared dependencies from the `workspaces` section. */
export interface Workspace {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** The parsed shape of a text `bun.lock` file (lockfileVersion 1). */
export interface BunLock {
  lockfileVersion?: number;
  workspaces?: Record<string, Workspace>;
  packages?: Record<string, unknown[]>;
  patchedDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export type DependencyRelationship = 'direct' | 'indirect';
export type DependencyScope = 'runtime' | 'development';

/** A resolved registry package, de-duplicated by `name@version`. */
export interface ResolvedPackage {
  key: string;
  purlName: string;
  purlNamespace: string | null;
  version: string;
  relationship: DependencyRelationship;
  scope: DependencyScope;
  edges: Set<string>;
}

export interface ResolveStats {
  totalEntries: number;
  resolved: number;
  skipped: number;
  invalid: number;
  aliasesResolved: number;
  skippedByProtocol: Record<string, number>;
}

type Classification =
  | { kind: 'registry'; name: string; version: string; aliased: boolean }
  | { kind: 'skip'; protocol: string }
  | { kind: 'invalid' };

/**
 * Non-registry dependency specifiers we cannot map to a `pkg:npm/...` PURL.
 * Detection is done positively (see {@link classifySpecifier}): any resolved
 * version that contains a ':' is treated as a protocol-qualified, non-registry
 * entry. This list is used only for human-readable reporting of *why* something
 * was skipped.
 */
export const NON_REGISTRY_PROTOCOLS = [
  'workspace:',
  'link:',
  'file:',
  'git:',
  'git+',
  'github:',
  'http:',
  'https:',
  'root:',
  'catalog:',
  'jsr:',
  'tarball:',
] as const;

/**
 * Parse the text `bun.lock` format. It is JSONC (JSON with trailing commas and,
 * potentially, comments), so a tolerant parser is used rather than `JSON.parse`.
 */
export function parseBunLock(text: string): BunLock {
  const errors: ParseError[] = [];
  const data = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(
      `Failed to parse lockfile as JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}`
    );
  }
  if (data === undefined || data === null || typeof data !== 'object') {
    throw new Error('Lockfile did not parse to an object.');
  }
  return data as BunLock;
}

/**
 * Locate the metadata object inside a `packages` tuple. Bun writes
 * variable-length tuples depending on package kind, so rather than assume a
 * fixed index we return the first plain object found.
 */
function findMetadata(tuple: unknown[]): Record<string, unknown> | undefined {
  for (let i = 1; i < tuple.length; i++) {
    const el = tuple[i];
    if (el && typeof el === 'object' && !Array.isArray(el)) {
      return el as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * Split a `name@version` identifier into its parts, correctly handling scoped
 * package names whose leading '@' must be ignored.
 */
export function splitNameVersion(id: string): { name: string; version: string } | null {
  const at = id.lastIndexOf('@');
  if (at <= 0) {
    // No '@' (bare name) or only the leading scope '@' — cannot extract a version.
    return null;
  }
  const name = id.slice(0, at);
  const version = id.slice(at + 1);
  if (!name || !version) {
    return null;
  }
  return { name, version };
}

/**
 * Classify the first tuple element (the `name@specifier` string) and, for
 * registry packages, return the resolved name/version. `npm:` aliases are
 * resolved to their real target so advisories match the actually-installed
 * package.
 */
export function classifySpecifier(id: unknown): Classification {
  if (typeof id !== 'string' || id.length === 0) {
    return { kind: 'invalid' };
  }

  // npm: alias, e.g. "my-alias@npm:real-pkg@1.2.3" or
  // "my-alias@npm:@scope/real@1.2.3". Resolve to the real target.
  const npmIdx = id.indexOf('@npm:');
  if (npmIdx !== -1) {
    const target = id.slice(npmIdx + '@npm:'.length);
    const parts = splitNameVersion(target);
    if (!parts) {
      return { kind: 'invalid' };
    }
    return { kind: 'registry', name: parts.name, version: parts.version, aliased: true };
  }

  const parts = splitNameVersion(id);
  if (!parts) {
    return { kind: 'invalid' };
  }

  // Semantic versions never contain ':'. Any ':' means a protocol-qualified,
  // non-registry specifier (workspace:, link:, file:, git+..., github:,
  // https://..., catalog:, jsr:, ...).
  if (parts.version.includes(':')) {
    const proto =
      NON_REGISTRY_PROTOCOLS.find((p) => parts.version.startsWith(p)) ??
      parts.version.slice(0, parts.version.indexOf(':') + 1);
    return { kind: 'skip', protocol: proto };
  }

  return { kind: 'registry', name: parts.name, version: parts.version, aliased: false };
}

/**
 * Build the set of directly-declared dependency names, and the runtime/dev
 * split, from the lockfile's `workspaces` section. All workspaces are unioned:
 * a package is "direct" if any workspace declares it, and "development" only if
 * it is declared exclusively in devDependencies.
 */
export function collectDeclaredDependencies(workspaces: Record<string, Workspace> | undefined): {
  directNames: Set<string>;
  devNames: Set<string>;
  prodNames: Set<string>;
  workspaceNames: Set<string>;
} {
  const directNames = new Set<string>();
  const devNames = new Set<string>();
  const prodNames = new Set<string>();
  const workspaceNames = new Set<string>();

  for (const wsKey of Object.keys(workspaces ?? {})) {
    const ws = workspaces![wsKey];
    if (!ws || typeof ws !== 'object') continue;
    if (typeof ws.name === 'string') {
      workspaceNames.add(ws.name);
    }
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const [name, spec] of Object.entries(ws[field] ?? {})) {
        directNames.add(name);
        prodNames.add(name);
        const alias = aliasTargetName(spec);
        if (alias) {
          directNames.add(alias);
          prodNames.add(alias);
        }
      }
    }
    for (const [name, spec] of Object.entries(ws.devDependencies ?? {})) {
      directNames.add(name);
      devNames.add(name);
      const alias = aliasTargetName(spec);
      if (alias) {
        directNames.add(alias);
        devNames.add(alias);
      }
    }
  }

  return { directNames, devNames, prodNames, workspaceNames };
}

/**
 * If a declared dependency spec is an `npm:` alias (e.g. `npm:lodash@^4.17.21`
 * or `npm:@scope/real@1.2.3`), return the real target package name so it can be
 * classified as a direct dependency under its resolved name.
 */
function aliasTargetName(spec: unknown): string | null {
  if (typeof spec !== 'string' || !spec.startsWith('npm:')) {
    return null;
  }
  const parts = splitNameVersion(spec.slice('npm:'.length));
  return parts ? parts.name : null;
}

/** Split a package name into its PURL namespace (scope) and name. */
export function splitScope(name: string): { namespace: string | null; name: string } {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash !== -1) {
      return { namespace: name.slice(0, slash), name: name.slice(slash + 1) };
    }
  }
  return { namespace: null, name };
}

/**
 * Resolve, for a given package entry key, which concrete registry package a
 * named dependency edge points to. Prefers the nested (deduped) resolution
 * `<parentKey>/<depName>` and falls back to the hoisted top-level entry.
 *
 * @returns the resolved `name@version` key, or null if unresolved / non-registry
 */
function resolveEdgeTarget(
  packages: Record<string, unknown[]>,
  parentKey: string,
  depName: string
): string | null {
  const candidates = [`${parentKey}/${depName}`, depName];
  for (const key of candidates) {
    const tuple = packages[key];
    if (Array.isArray(tuple) && typeof tuple[0] === 'string') {
      const info = classifySpecifier(tuple[0]);
      if (info.kind === 'registry') {
        return `${info.name}@${info.version}`;
      }
      return null;
    }
  }
  return null;
}

/**
 * Resolve the full set of registry packages from a parsed bun.lock object.
 *
 * Returns a de-duplicated list keyed by `name@version`, each carrying its PURL
 * parts, direct/indirect relationship, runtime/development scope, and the
 * `name@version` keys of its resolved dependency edges (best-effort).
 */
export function resolvePackages(lockData: BunLock): {
  resolved: ResolvedPackage[];
  stats: ResolveStats;
} {
  const packages =
    lockData && typeof lockData.packages === 'object' && lockData.packages ? lockData.packages : {};
  const workspaces = lockData && typeof lockData.workspaces === 'object' ? lockData.workspaces : {};

  const { directNames, devNames, prodNames } = collectDeclaredDependencies(workspaces);

  const byKey = new Map<string, ResolvedPackage>();
  const stats: ResolveStats = {
    totalEntries: 0,
    resolved: 0,
    skipped: 0,
    invalid: 0,
    aliasesResolved: 0,
    skippedByProtocol: {},
  };

  for (const entryKey of Object.keys(packages)) {
    stats.totalEntries++;
    const tuple = packages[entryKey];
    if (!Array.isArray(tuple) || typeof tuple[0] !== 'string') {
      stats.invalid++;
      continue;
    }

    const info = classifySpecifier(tuple[0]);
    if (info.kind === 'skip') {
      stats.skipped++;
      stats.skippedByProtocol[info.protocol] = (stats.skippedByProtocol[info.protocol] ?? 0) + 1;
      continue;
    }
    if (info.kind === 'invalid') {
      stats.invalid++;
      continue;
    }
    if (info.aliased) {
      stats.aliasesResolved++;
    }

    const dedupeKey = `${info.name}@${info.version}`;
    const relationship: DependencyRelationship = directNames.has(info.name) ? 'direct' : 'indirect';
    const scope: DependencyScope =
      devNames.has(info.name) && !prodNames.has(info.name) ? 'development' : 'runtime';

    // Collect dependency edges from this entry's metadata.
    const meta = findMetadata(tuple) ?? {};
    const edgeNames = new Set<string>();
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
      const deps = meta[field];
      if (deps && typeof deps === 'object') {
        for (const depName of Object.keys(deps)) {
          edgeNames.add(depName);
        }
      }
    }
    const edges = new Set<string>();
    for (const depName of edgeNames) {
      const target = resolveEdgeTarget(packages, entryKey, depName);
      if (target && target !== dedupeKey) {
        edges.add(target);
      }
    }

    const existing = byKey.get(dedupeKey);
    if (existing) {
      // Same resolved package reached via multiple tree positions: merge edges
      // and keep the strongest relationship (direct wins).
      for (const e of edges) existing.edges.add(e);
      if (relationship === 'direct') existing.relationship = 'direct';
    } else {
      const { namespace, name } = splitScope(info.name);
      byKey.set(dedupeKey, {
        key: dedupeKey,
        purlName: name,
        purlNamespace: namespace,
        version: info.version,
        relationship,
        scope,
        edges,
      });
      stats.resolved++;
    }
  }

  return { resolved: Array.from(byKey.values()), stats };
}
