import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import { changedFiles, gitRoot, mergeBase, showFile } from './git.ts';
import { fragmentKey, hashOf, loadModule, moduleFragments, nodeId, parseNodeId, type UsageGraph } from './graph.ts';
import { diffVersions, LOCKFILES, parseLockfile } from './lockfile.ts';
import { isInNodeModules } from './resolve.ts';
import { runTailwind } from './tailwind.ts';

export const MANIFEST_VERSION = 1;

/** Per-fragment hashes of everything the app uses. Save it on the base branch, compare on a PR. */
export interface Manifest {
  version: number;
  fingerprint: string;
  fragments: Record<string, string>;
}

export interface AffectedReason {
  kind: 'source' | 'input' | 'dependency' | 'unresolved' | 'manifest';
  /** Fragment key, input path or package name. */
  key: string;
  detail: string;
  /** Node ids from an entry down to the changed fragment. Format with `describeNode`. */
  chain: string[];
}

export interface IgnoredChange {
  path: string;
  /** Fragment ids that changed but nothing uses. Empty when the file is outside the graph. */
  fragments: string[];
}

export interface AffectedResult {
  affected: boolean;
  fingerprint: string;
  /** Commit the working tree was compared with (git mode). */
  base?: string;
  reasons: AffectedReason[];
  ignored: IgnoredChange[];
}

export const createManifest = (graph: UsageGraph): Manifest => {
  const fragments: Record<string, string> = {};
  for (const key of [...graph.live.keys()].sort()) fragments[key] = graph.live.get(key)?.hash ?? '';
  return { version: MANIFEST_VERSION, fingerprint: graph.fingerprint(), fragments };
};

export const readManifest = (file: string): Manifest => {
  const json = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  if (json.version !== MANIFEST_VERSION || typeof json.fragments !== 'object') {
    throw new Error(`${file} is not a byakugan manifest (version ${MANIFEST_VERSION})`);
  }
  return json;
};

/** Exact comparison, node_modules included: both sides were hashed from installed code. */
export const affectedSinceManifest = (graph: UsageGraph, base: Manifest): AffectedResult => {
  const reasons: AffectedReason[] = [];
  for (const [key, fragment] of graph.live) {
    const before = base.fragments[key];
    if (before === fragment.hash) continue;
    reasons.push({ kind: 'manifest', key, detail: before === undefined ? 'newly used' : 'changed', chain: graph.chain(fragment.via) });
  }
  for (const key of Object.keys(base.fragments)) {
    if (!graph.live.has(key)) reasons.push({ kind: 'manifest', key, detail: 'no longer used', chain: [] });
  }
  return { affected: reasons.length > 0, fingerprint: graph.fingerprint(), reasons, ignored: [] };
};

const packageNameOfKey = (key: string): string | undefined => {
  if (!key.startsWith('npm:')) return;
  const rest = key.slice(4).split(/[#/]/);
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
};

const isPackageSpecifier = (specifier: string) => /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/.*)?$/i.test(specifier);

const filteredManifest = (content: Buffer) => {
  const manifest = JSON.parse(content.toString()) as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) delete manifest[field];
  return JSON.stringify(manifest);
};

/**
 * Git mode: compares the working tree with the merge base of `base` and HEAD.
 * Project files are compared per fragment. Dependencies are compared per package via the lockfile,
 * since the base side of node_modules is not installed. Use a manifest for file-level precision there.
 */
export const affectedSinceCommit = (graph: UsageGraph, base: string): AffectedResult => {
  const { project } = graph;
  const git = gitRoot(project.dir);
  if (!git) throw new Error(`${project.dir} is not inside a git repository`);
  const commit = mergeBase(git, base);
  const reasons: AffectedReason[] = [];
  const ignored: IgnoredChange[] = [];
  const isInput = picomatch(project.inputPatterns, { dot: true });
  const isEntry = picomatch(project.entryPatterns, { dot: true });
  const projectManifest = join(project.dir, 'package.json');
  const deleted: string[] = [];
  /** Base-side content of every changed file, `null` when HEAD added it. Tailwind rescans with it. */
  const baseContents: Record<string, string | null> = {};

  const usedPackages = new Map<string, number>();
  for (const key of graph.live.keys()) {
    const name = packageNameOfKey(key);
    if (name) usedPackages.set(name, (usedPackages.get(name) ?? 0) + 1);
  }

  for (const change of changedFiles(git, commit)) {
    const file = join(project.root, change.path);
    const name = basename(file);
    if (graph.tailwind.size > 0 && !LOCKFILES.has(name)) {
      baseContents[file] = change.status === 'A' ? null : (showFile(git, commit, change.path)?.toString() ?? null);
    }

    if (LOCKFILES.has(name)) {
      const head = change.status === 'D' ? '' : readFileSync(file, 'utf8');
      const before = showFile(git, commit, change.path)?.toString() ?? '';
      const a = parseLockfile(name, before);
      const b = parseLockfile(name, head);
      if (!a || !b) {
        reasons.push({ kind: 'dependency', key: change.path, detail: 'lockfile changed and could not be parsed', chain: [] });
        continue;
      }
      const used = diffVersions(a, b).filter(c => usedPackages.has(c.name));
      for (const c of used) {
        const files = usedPackages.get(c.name) ?? 0;
        const from = c.before.join(', ') || 'none';
        const to = c.after.join(', ') || 'removed';
        reasons.push({ kind: 'dependency', key: c.name, detail: `${from} -> ${to} (${files} used fragment${files === 1 ? '' : 's'})`, chain: [] });
      }
      if (used.length === 0) ignored.push({ path: change.path, fragments: [] });
      continue;
    }

    const inputKey = graph.fileKey(file);
    const input = graph.live.get(inputKey);
    if (input && parseNodeId(input.via).kind === 'I') {
      const before = showFile(git, commit, change.path);
      const beforeHash = before === undefined ? undefined : hashOf(file === projectManifest ? filteredManifest(before) : before);
      if (beforeHash !== input.hash) reasons.push({ kind: 'input', key: inputKey, detail: before === undefined ? 'added' : 'changed', chain: [] });
      else ignored.push({ path: change.path, fragments: [] });
      continue;
    }
    const relativeToProject = relative(project.dir, file).split(sep).join('/');
    if (change.status === 'D' && !relativeToProject.startsWith('..') && isInput(relativeToProject)) {
      reasons.push({ kind: 'input', key: inputKey, detail: 'deleted', chain: [] });
      continue;
    }

    const head = graph.module(file);
    if (!head) {
      if (change.status === 'D') {
        deleted.push(file);
        const entry = (!relativeToProject.startsWith('..') && isEntry(relativeToProject)) || project.namedFiles.includes(file);
        const where = entry ? 'it was an entry' : pointedAt(graph, file);
        if (where) {
          reasons.push({ kind: 'source', key: graph.fileKey(file), detail: `deleted (${where})`, chain: [] });
          continue;
        }
      }
      ignored.push({ path: change.path, fragments: [] });
      continue;
    }

    const before = showFile(git, commit, change.path);
    const baseFragments = before === undefined ? new Map<string, string>() : moduleFragments(loadModule(file, before).module);
    const headFragments = moduleFragments(head);
    const fileKey = graph.fileKey(file);
    const changed: string[] = [];
    let live = false;
    for (const id of new Set([...baseFragments.keys(), ...headFragments.keys()])) {
      if (baseFragments.get(id) === headFragments.get(id)) continue;
      changed.push(id);
      const fragment = graph.live.get(fragmentKey(fileKey, id));
      if (!fragment) {
        const wanted = headFragments.has(id) ? undefined : graph.wants(file, id);
        if (wanted === undefined) continue;
        live = true;
        reasons.push({ kind: 'source', key: fragmentKey(fileKey, id), detail: 'removed', chain: graph.chain(wanted) });
        continue;
      }
      live = true;
      const detail = baseFragments.has(id) ? 'changed' : 'added';
      reasons.push({ kind: 'source', key: fragment.key, detail, chain: graph.chain(fragment.via) });
    }
    if (!live) ignored.push({ path: change.path, fragments: changed });
  }

  if (deleted.length > 0) {
    for (const u of graph.unresolved) {
      if (isPackageSpecifier(u.specifier) || isInNodeModules(u.from)) continue;
      reasons.push({
        kind: 'unresolved',
        key: `${graph.fileKey(u.from)} -> ${u.specifier}`,
        detail: `cannot resolve "${u.specifier}" (a deleted file may have been the target)`,
        chain: [],
      });
    }
  }

  if (Object.keys(baseContents).length > 0) {
    const roots = [...graph.tailwind.values()].filter(r => r.hash !== undefined);
    const results = roots.length > 0 ? runTailwind({ dir: project.dir, roots: roots.map(r => r.file), overrides: baseContents }) : [];
    for (const result of results) {
      const head = graph.tailwind.get(result.file);
      if (!head || result.hash === head.hash) continue;
      const scanned = new Set([...head.files, ...result.files]);
      const sources = Object.keys(baseContents).filter(f => scanned.has(f) || !existsSync(f));
      const paths = new Set(sources.map(f => relative(project.root, f).split(sep).join('/')));
      reasons.push({
        kind: 'source',
        key: `${graph.fileKey(result.file)}#<tailwind>`,
        detail: result.hash === undefined ? `cannot run Tailwind on the base side (${result.error})` : `generated CSS changes (${[...paths].join(', ')})`,
        chain: graph.chain(nodeId('M', result.file)),
      });
      for (let i = ignored.length - 1; i >= 0; i--) if (paths.has(ignored[i].path)) ignored.splice(i, 1);
    }
  }

  return { affected: reasons.length > 0, fingerprint: graph.fingerprint(), base: commit, reasons, ignored };
};

/** Why a deleted file still mattered: a computed import, a directory the code reads, or a path in the code. */
const pointedAt = (graph: UsageGraph, file: string): string | undefined => {
  const path = file.split(sep).join('/');
  if (graph.patterns.missing.has(file)) return 'the code refers to this path';
  if (graph.patterns.contexts.some(regex => regex.test(path))) return 'matches a computed import';
  if (graph.patterns.trees.some(dir => file.startsWith(dir + sep))) return 'inside a directory the code reads';
};
