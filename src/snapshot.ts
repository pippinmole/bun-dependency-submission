import { PackageURL } from 'packageurl-js';
import {
  PackageCache,
  Manifest,
  Snapshot,
  type Detector,
} from '@github/dependency-submission-toolkit';
import type { Context } from '@actions/github/lib/context';
import type { ResolvedPackage } from './parse';

/** Construct a canonical npm PURL for a resolved package entry. */
export function toPackageURL(p: ResolvedPackage): PackageURL {
  return new PackageURL(
    'npm',
    p.purlNamespace ?? undefined,
    p.purlName,
    p.version,
    undefined,
    undefined
  );
}

/**
 * Build a toolkit Manifest (and its backing PackageCache) from the resolved
 * package list produced by `resolvePackages`.
 *
 * Every resolved registry package is added to the manifest so that advisory
 * matching sees the complete tree; dependency edges enrich the graph but are
 * never relied upon to include a package.
 */
export function buildManifest(
  resolved: ResolvedPackage[],
  manifestName: string
): { manifest: Manifest; cache: PackageCache } {
  const cache = new PackageCache();

  // First pass: register every package so edges can reference them.
  const purlByKey = new Map<string, string>();
  for (const p of resolved) {
    const purl = toPackageURL(p);
    const purlStr = purl.toString();
    purlByKey.set(p.key, purlStr);
    cache.package(purl);
  }

  // Second pass: wire dependency edges (best-effort).
  for (const p of resolved) {
    const pkg = cache.lookupPackage(purlByKey.get(p.key)!);
    if (!pkg) continue;
    for (const edgeKey of p.edges) {
      const targetPurl = purlByKey.get(edgeKey);
      if (!targetPurl) continue;
      const dep = cache.lookupPackage(targetPurl);
      if (dep) {
        pkg.dependsOn(dep);
      }
    }
  }

  // Third pass: add to the manifest with relationship + scope.
  const manifest = new Manifest(manifestName, manifestName);
  for (const p of resolved) {
    const pkg = cache.lookupPackage(purlByKey.get(p.key)!);
    if (!pkg) continue;
    if (p.relationship === 'direct') {
      manifest.addDirectDependency(pkg, p.scope);
    } else {
      manifest.addIndirectDependency(pkg, p.scope);
    }
  }

  return { manifest, cache };
}

/** Build a complete Snapshot ready to submit. */
export function buildSnapshot(
  manifest: Manifest,
  opts: { detector: Detector; context?: Context }
): Snapshot {
  const snapshot = new Snapshot(opts.detector, opts.context);
  snapshot.addManifest(manifest);
  return snapshot;
}
