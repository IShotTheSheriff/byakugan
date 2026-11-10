import { affectedSinceCommit, affectedSinceManifest, createManifest, type AffectedResult, type Manifest } from './affected.ts';
import { UsageGraph } from './graph.ts';
import { loadProject, type LoadProjectOptions } from './project.ts';

export { affectedSinceCommit, affectedSinceManifest, createManifest, manifestMismatch, readManifest, MANIFEST_VERSION } from './affected.ts';
export type { AffectedReason, AffectedResult, IgnoredChange, Manifest } from './affected.ts';
export { UsageGraph, moduleFragments, loadModule, fragmentKey, nodeId, parseNodeId } from './graph.ts';
export type { FileRecord, LiveFragment, ModuleCache, NodeKind, Unresolved } from './graph.ts';
export { parseModule } from './parse.ts';
export type { Decl, EsmModule, ExportEntry, ImportBinding, ModuleInfo, OpaqueModule, Usage } from './parse.ts';
export { loadProject } from './project.ts';
export { workspaceApps, workspacePatterns } from './workspace.ts';
export { eachFingerprints, eachProject, eachSinceManifest, entriesReaching } from './select.ts';
export { compareBuilds } from './compare.ts';
export type { BuildDifference } from './compare.ts';
export type { EachProject, EachResult } from './select.ts';
export type { WorkspaceApp } from './workspace.ts';
export type { Config, Framework, LoadProjectOptions, Project } from './project.ts';
export { Resolver, DEFAULT_MODULARIZE } from './resolve.ts';
export type { ModularizeRule, PackageInfo, ResolverOptions } from './resolve.ts';
export { summarize, formatGraph, formatMermaid, formatDot, formatAffected, formatChain, describeNode, why, formatWhy } from './report.ts';
export type { FileSummary, GraphSummary, PackageSummary, WhyMatch, WhyResult } from './report.ts';

/** Builds the graph of code the project at `cwd` uses. */
export const analyze = (options: LoadProjectOptions = {}): UsageGraph => new UsageGraph(loadProject(options)).build();

/** SHA-256 over every used fragment. Equal fingerprints mean equal app inputs; use it as a CI cache key. */
export const fingerprint = (options: LoadProjectOptions = {}): string => analyze(options).fingerprint();

export const manifest = (options: LoadProjectOptions = {}): Manifest => createManifest(analyze(options));

export interface AffectedOptions extends LoadProjectOptions {
  /** Git ref to compare the working tree with (merge base with HEAD is used). */
  base?: string;
  /** Manifest saved from the base build. Exact for dependency updates too. */
  baseManifest?: Manifest;
}

export const affected = (options: AffectedOptions): AffectedResult => {
  const graph = analyze(options);
  if (options.baseManifest) return affectedSinceManifest(graph, options.baseManifest);
  if (options.base) return affectedSinceCommit(graph, options.base);
  throw new Error('affected() needs `base` or `baseManifest`');
};
