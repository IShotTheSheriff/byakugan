import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { readText } from './fs.ts';
import { changedFiles, gitRoot, ignoredFiles, mergeBase, showFiles, trackedLinks } from './git.ts';
import { globMatcher, safeGlob, staticPrefix } from './glob.ts';
import {
  fragmentKey,
  hashOf,
  loadModule,
  moduleFragments,
  nodeId,
  parseNodeId,
  STYLE_EXTENSIONS,
  valueRequests,
  type UsageGraph,
} from './graph.ts';
import { diffVersions, LOCKFILES, parseLockfile } from './lockfile.ts';
import type { ModuleInfo, ModuleRequest } from './parse.ts';
import { isInNodeModules } from './resolve.ts';
import { runTailwind } from './tailwind.ts';
import { toolVersion } from './version.ts';

export const MANIFEST_VERSION = 2;

/** Per-fragment hashes of everything the app uses. Save it on the base branch, compare on a PR. */
export interface Manifest {
  version: number;
  /** The byakugan version that wrote it. Another version may hash the same code differently. */
  byakugan?: string;
  /** The mode it was written in. `strict` holds fragments `behavior` leaves out. */
  mode?: 'behavior' | 'strict';
  fingerprint: string;
  fragments: Record<string, string>;
  /** Written with `--each`: per matched file, a fingerprint of the fragments that file reaches. */
  each?: Record<string, string>;
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
  /** Things the graph could not follow, and notes on the comparison. */
  warnings: string[];
}

/** `each` adds per-file fingerprints, from `eachFingerprints`, for `affected --each --base-manifest`. */
export const createManifest = (graph: UsageGraph, each?: Record<string, string>): Manifest => {
  const fragments: Record<string, string> = {};
  for (const key of [...graph.live.keys()].sort()) fragments[key] = graph.live.get(key)?.hash ?? '';
  const mode = graph.project.config.mode ?? 'behavior';
  return { version: MANIFEST_VERSION, byakugan: toolVersion(), mode, fingerprint: graph.fingerprint(), fragments, ...(each ? { each } : {}) };
};

/**
 * Why `base` cannot be compared with a graph built now, if it cannot. Comparing anyway would list
 * hundreds of fragments as changed, with nothing to say that the manifest is the cause.
 */
export const manifestMismatch = (graph: UsageGraph, base: Manifest): string | undefined => {
  const mode = graph.project.config.mode ?? 'behavior';
  if (base.version !== MANIFEST_VERSION) return `the manifest has format ${base.version} and this byakugan writes format ${MANIFEST_VERSION}; save a new one`;
  if (base.byakugan !== toolVersion()) {
    return `the manifest was written by byakugan ${base.byakugan ?? '(unknown)'} and this is ${toolVersion()}, which may hash the same code differently; save a new one`;
  }
  if (base.mode !== mode) return `the manifest was written in ${base.mode ?? '(unknown)'} mode and this run is in ${mode} mode; use the same mode for both`;
};

export const readManifest = (file: string): Manifest => {
  const json = JSON.parse(readFileSync(file, 'utf8')) as Manifest | null;
  const fragments = json?.fragments;
  const strings = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(v => typeof v === 'string');
  const text = (value: unknown) => value === undefined || typeof value === 'string';
  const valid =
    text(json?.byakugan) &&
    text(json?.mode) &&
    (json?.each === undefined || strings(json.each)) &&
    typeof json === 'object' &&
    json !== null &&
    typeof json.version === 'number' &&
    typeof fragments === 'object' &&
    fragments !== null &&
    !Array.isArray(fragments) &&
    Object.values(fragments).every(v => typeof v === 'string');
  if (!valid) throw new Error(`${file} is not a byakugan manifest`);
  return json;
};

/** Imports the graph could not resolve. It cannot see what is behind them, so they count as affected. */
const unresolvedReasons = (graph: UsageGraph): AffectedReason[] =>
  graph.unresolved
    // A type-only import cannot change the bundle. React Router's `./+types/route` is generated later, for one.
    .filter(u => !u.type && graph.isProjectImport(u))
    .map(u => ({
      kind: 'unresolved' as const,
      key: `${graph.fileKey(u.from)} -> ${u.specifier}`,
      detail: `cannot resolve "${u.specifier}", so a change behind it would be invisible (a deleted file, or an alias byakugan does not read)`,
      chain: [],
    }));

/** Exact comparison, node_modules included: both sides were hashed from installed code. */
export const affectedSinceManifest = (graph: UsageGraph, base: Manifest): AffectedResult => {
  const mismatch = manifestMismatch(graph, base);
  if (mismatch) {
    const reasons: AffectedReason[] = [{ kind: 'manifest', key: 'manifest', detail: mismatch, chain: [] }];
    return { affected: true, fingerprint: graph.fingerprint(), reasons, ignored: [], warnings: [...graph.warnings] };
  }
  const reasons: AffectedReason[] = unresolvedReasons(graph);
  for (const [key, fragment] of graph.live) {
    const before = base.fragments[key];
    if (before === fragment.hash) continue;
    reasons.push({ kind: 'manifest', key, detail: before === undefined ? 'newly used' : 'changed', chain: graph.chain(fragment.via) });
  }
  for (const key of Object.keys(base.fragments)) {
    if (!graph.live.has(key)) reasons.push({ kind: 'manifest', key, detail: 'no longer used', chain: [] });
  }
  return { affected: reasons.length > 0, fingerprint: graph.fingerprint(), reasons, ignored: [], warnings: [...graph.warnings] };
};

const packageNameOfKey = (key: string): string | undefined => {
  if (!key.startsWith('npm:')) return;
  const rest = key.slice(4).split(/[#/]/);
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
};

/**
 * The package a patch file changes: patch-package `@scope+name+1.0.0.patch` (`a++b+1.0.0` for
 * nested), pnpm `@scope__name@1.0.0.patch`. Undefined when the name cannot be told apart from
 * the version, as in yarn's `name-npm-1.0.0-hash.patch`.
 */
const patchedPackage = (path: string): string | undefined => {
  const name = basename(path).replace(/\.(patch|diff)$/, '');
  if (path.includes('.yarn/')) return;
  const at = name.indexOf('@', 1);
  if (at > 0 && !name.includes('+')) return name.slice(0, at).replace('__', '/');
  const parts = name.split('++').pop()?.split('+') ?? [];
  if (parts.length < 2) return;
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
};

const PATCH_FILE = /(^|\/)(patches\/[^/]+|\.yarn\/patches\/[^/]+)\.(patch|diff)$/;

/** `lib/util.ts` and `lib/util/index.ts` answer the same import: deleting one makes it resolve to the other. */
const stem = (file: string) => file.replace(/\.d\.[cm]?ts$/, '').replace(/\.[^./\\]+$/, '');
const CODE_FILE = /\.([cm]?[jt]sx?|json)$/;

/** Is `file` there with exactly this case, directories included? On macOS, `existsSync` ignores case. */
const exactCase = (file: string, top: string) => {
  for (let current = file; current.startsWith(top + sep); current = dirname(current)) {
    try {
      if (!readdirSync(dirname(current)).includes(basename(current))) return false;
    } catch {
      return false;
    }
  }
  return true;
};

/** What the file at the base commit tells about the change, for files the working tree changed. */
interface BaseSide {
  /** Base-side content of a changed file; undefined when it is unchanged or was added. */
  content(file: string): Buffer | undefined;
  changed: Set<string>;
  /** Changed files the working tree no longer has. */
  deleted: string[];
  /** Files this change added: the base side had nothing there. */
  added: Set<string>;
}

/**
 * What changed in which modules a file runs: an import added or removed, or imports reordered.
 * Only imports of modules with side effects count; importing a module that only declares things runs nothing.
 */
const requestChanges = (graph: UsageGraph, file: string, base: ModuleInfo | undefined, head: ModuleInfo, side: BaseSide): string[] => {
  const modularize = graph.resolver.modularize;
  const { changed } = side;
  // A target deleted along with its import: found among the deleted files by the path it resolved to.
  const deletedTargets = (from: string, source: string) => {
    const bases = source.startsWith('.') ? [resolve(dirname(from), source)] : graph.project.aliasTargets(source);
    return side.deleted.filter(d => bases.some(b => d === b || stem(d) === b || stem(d) === stem(b) || (dirname(d) === b && basename(d).startsWith('index.'))));
  };
  /**
   * What `r` in `from` resolved to at the base commit, as far as git mode can tell: its targets
   * now, minus files this change added, plus deleted files it may have named. Undefined when that
   * is unknown: the import resolves only to added files and nothing deleted matches (`fancy.ts`
   * added in front of `fancy/index.ts`), or it resolves to nothing at all now.
   */
  const baseTargets = (from: string, r: ModuleRequest): string[] | undefined => {
    const head = graph.requestTargets(from, r);
    const resolves = head.length > 0 || graph.resolver.resolve(r.source, from).length > 0;
    const targets = new Set([...head.filter(t => !side.added.has(t)), ...deletedTargets(from, r.source)]);
    if (targets.size === 0 && (!resolves || head.length > 0)) return;
    // Resolving with no targets means a `sideEffects: false` package: the bundler drops it.
    return [...targets];
  };
  // Did importing `start` run code at the base commit? Its import closure is walked with the
  // base-side content of every file the change edited or deleted, so a side effect removed one
  // hop away still counts. Anything the walk cannot see counts as code.
  const ranCode = (start: string): boolean => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const target = queue.pop() as string;
      if (seen.has(target)) continue;
      if (seen.size >= 10_000) return true;
      seen.add(target);
      const content = changed.has(target) ? side.content(target) : undefined;
      // Added by this change: the base side had nothing there to run.
      if (changed.has(target) && content === undefined) continue;
      if (content === undefined && graph.effectful(target)) return true;
      const module = content === undefined ? graph.module(target) : loadModule(target, content, graph.parseOptions).module;
      if (!module) continue;
      if (module.kind !== 'esm') {
        if (module.reason !== 'asset' || STYLE_EXTENSIONS.has(extname(target))) return true;
        continue;
      }
      if (module.effects.runs) return true;
      for (const r of valueRequests(module, modularize)) {
        if (graph.resolver.isBuiltin(r.source)) continue;
        const targets = baseTargets(target, r);
        if (targets === undefined) return true;
        for (const t of targets) queue.push(t);
      }
    }
    return false;
  };
  const id = (r: ModuleRequest) => `${r.bare ? 'import' : 'from'} ${r.source}`;
  const before = base ? valueRequests(base, modularize) : [];
  const after = valueRequests(head, modularize);
  const beforeIds = new Set(before.map(id));
  const afterIds = new Set(after.map(id));
  const effectful = (r: ModuleRequest) => graph.requestTargets(file, r).some(t => graph.effectful(t));
  const out: string[] = [];
  for (const r of after) {
    if (beforeIds.has(id(r))) continue;
    for (const target of graph.requestTargets(file, r)) {
      if (!graph.effectful(target)) continue;
      // Already run before `file` in every entry that runs `file`: importing it again runs nothing new.
      if (ranBefore(graph, target, file)) continue;
      out.push(`imports ${r.source}, which runs code`);
      break;
    }
  }
  for (const r of before) {
    if (afterIds.has(id(r)) || graph.resolver.isBuiltin(r.source)) continue;
    const targets = baseTargets(file, r);
    // Nothing to look at: a package that is gone, a virtual module, a target only this change added.
    if (targets === undefined) out.push(`no longer imports ${r.source}, which may have run code`);
    else if (targets.some(t => !graph.isEvaluated(t) && ranCode(t))) out.push(`no longer imports ${r.source}, which ran code`);
  }
  const order = (list: ModuleRequest[], other: Set<string>) => list.filter(r => other.has(id(r)) && effectful(r)).map(id);
  if (out.length === 0 && order(before, afterIds).join('\n') !== order(after, beforeIds).join('\n')) {
    out.push('imports of modules with side effects changed order');
  }
  return out;
};

const isLink = (file: string) => {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

const isDirectory = (file: string) => {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Whether `target` starts running before `file` in every entry that runs `file`, in ESM order:
 * depth first, imports in source order. Then a new import of it from `file` runs nothing new.
 * False when no entry is seen to run `file`.
 */
const ranBefore = (graph: UsageGraph, target: string, file: string): boolean => {
  const modularize = graph.resolver.modularize;
  const children = (f: string): string[] => {
    const module = graph.module(f);
    if (module?.kind === 'esm') return valueRequests(module, modularize).flatMap(r => graph.requestTargets(f, r));
    return [...(graph.edges.get(f)?.keys() ?? [])];
  };
  let reached = false;
  for (const entry of graph.project.entries) {
    const entered = new Set<string>();
    const stack = [entry];
    let found = false;
    while (stack.length > 0) {
      const f = stack.pop() as string;
      if (entered.has(f)) continue;
      if (f === file) {
        found = true;
        break;
      }
      entered.add(f);
      const next = children(f);
      // Pushed last to first, so the first import is entered first.
      for (let i = next.length - 1; i >= 0; i--) if (!entered.has(next[i])) stack.push(next[i]);
    }
    if (!found) continue;
    reached = true;
    if (!entered.has(target)) return false;
  }
  return reached;
};

/**
 * Git mode: compares the working tree with the merge base of `base` and HEAD.
 * Project files are compared per fragment. Dependencies are compared per package via the lockfile,
 * since the base side of node_modules is not installed. Use a manifest for file-level precision there.
 */
export const affectedSinceCommit = (graph: UsageGraph, base: string): AffectedResult => {
  const { project } = graph;
  const found = gitRoot(project.dir);
  if (!found) throw new Error(`${project.dir} is not inside a git repository`);
  const top = realpathSync(found);
  const { commit, exact } = mergeBase(top, base);
  const warnings = [...graph.warnings];
  if (!exact) warnings.push(`${base} and HEAD have no merge base (a shallow clone?), so changes on ${base} itself count too`);
  const reasons: AffectedReason[] = unresolvedReasons(graph);
  const ignored: IgnoredChange[] = [];
  const isInput = globMatcher(project.inputPatterns, { dot: true });
  const isEntry = globMatcher(project.entryPatterns, { dot: true });
  const isGenerated = globMatcher(project.config.generated ?? [], { dot: true });
  /** Base-side content of every changed file, `null` when HEAD added it. Tailwind rescans with it. */
  const baseContents: Record<string, string | null> = {};
  const toProject = (file: string) => relative(project.dir, file).split(sep).join('/');
  const inProject = (file: string) => !toProject(file).startsWith('..');

  const usedPackages = new Map<string, number>();
  for (const key of graph.live.keys()) {
    const name = packageNameOfKey(key);
    if (name) usedPackages.set(name, (usedPackages.get(name) ?? 0) + 1);
  }

  const changes = changedFiles(top, commit);
  const before = showFiles(
    top,
    commit,
    changes.filter(c => c.status !== 'A').map(c => c.path)
  );

  // An entry glob that follows a symlinked directory keys `linked/a.ts`; git reports `real/a.ts`.
  const realOf = new Map<string, string>();
  const aliasOf = new Map<string, string>();
  const realDirs = new Map<string, string>();
  const realPath = (file: string) => {
    if (isLink(file)) {
      try {
        return realpathSync(file);
      } catch {
        return file;
      }
    }
    const dir = dirname(file);
    let real = realDirs.get(dir);
    if (real === undefined) {
      try {
        real = realpathSync(dir);
      } catch {
        real = dir;
      }
      realDirs.set(dir, real);
    }
    return join(real, basename(file));
  };
  const graphFiles = new Set(graph.files.keys());
  for (const f of graph.live.values()) if (f.file) graphFiles.add(f.file);
  for (const file of graphFiles) {
    if (isInNodeModules(file) || !file.startsWith(top + sep)) continue;
    const real = realPath(file);
    if (real === file) continue;
    realOf.set(file, real);
    if (!graphFiles.has(real) && !aliasOf.has(real)) aliasOf.set(real, file);
  }
  const toRepo = (file: string) => relative(top, realOf.get(file) ?? file).split(sep).join('/');
  // Tracked links to directories, by the directory they name, even when it is gone: a deleted
  // `real/a.ts` was `linked/a.ts` to an entry glob.
  const dirLinks: Array<[link: string, target: string]> = [];
  for (const path of trackedLinks(top)) {
    const link = join(top, path);
    try {
      dirLinks.push([link, resolve(dirname(link), readlinkSync(link))]);
    } catch {}
  }
  const viaLinks = (file: string) => dirLinks.flatMap(([link, target]) => (file.startsWith(target + sep) ? [join(link, relative(target, file))] : []));
  const patternDirs = [...project.entryPatterns, ...project.inputPatterns].map(staticPrefix).filter(d => d !== '');
  /**
   * Whether a directory link at `link` lists files an entry or input pattern takes: the files
   * under `target` when it exists, else any pattern whose fixed directories reach the link.
   */
  const linkMatters = (link: string, target: string | undefined) => {
    if (target !== undefined && isDirectory(target)) {
      const files = safeGlob(['**/*'], { cwd: target, boundary: top, dot: true, ignore: ['**/node_modules/**', '**/.git/**'] });
      return files.some(f => {
        const path = toProject(join(link, relative(target, f)));
        return !path.startsWith('..') && (isEntry(path) || isInput(path));
      });
    }
    const path = toProject(link);
    return !path.startsWith('..') && patternDirs.some(d => path === d || path.startsWith(`${d}/`) || d.startsWith(`${path}/`));
  };
  const side: BaseSide = {
    content: file => before.get(toRepo(file)),
    changed: new Set(changes.flatMap(c => [join(top, c.path), ...(aliasOf.has(join(top, c.path)) ? [aliasOf.get(join(top, c.path)) as string] : [])])),
    deleted: changes.filter(c => c.status === 'D').map(c => join(top, c.path)),
    added: new Set(changes.filter(c => c.status === 'A').map(c => aliasOf.get(join(top, c.path)) ?? join(top, c.path))),
  };

  // Files the graph reads that git ignores: git mode has nothing to compare them with.
  const reached = new Set<string>();
  for (const r of graph.files.values()) if (!isInNodeModules(r.file) && (r.evaluated || r.used.size > 0)) reached.add(r.file);
  for (const f of graph.live.values()) if (f.file && !isInNodeModules(f.file) && parseNodeId(f.via).kind === 'I') reached.add(f.file);
  // Real paths: check-ignore refuses a path beyond a symlink. The links on the way are asked
  // about too, since an ignored, untracked link hides what is behind it.
  const reachedPaths = [...reached].filter(f => f.startsWith(top + sep)).map(toRepo);
  const linkFor = new Map<string, string[]>();
  for (const file of reached) {
    if (!realOf.has(file)) continue;
    for (let dir = dirname(file); dir.startsWith(top + sep); dir = dirname(dir)) {
      if (!isLink(dir)) continue;
      const path = relative(top, dir).split(sep).join('/');
      linkFor.set(path, [...(linkFor.get(path) ?? []), file]);
    }
  }
  const gitIgnored = ignoredFiles(top, [...new Set([...reachedPaths, ...linkFor.keys()])]);
  for (const link of [...(gitIgnored ?? [])].filter(p => linkFor.has(p))) {
    gitIgnored?.delete(link);
    for (const file of linkFor.get(link) ?? []) gitIgnored?.add(toRepo(file));
  }
  if (gitIgnored === undefined) {
    reasons.push({ kind: 'source', key: '.gitignore', detail: 'git cannot tell which files it ignores, so ignored files may hide changes', chain: [] });
  }
  for (const path of gitIgnored ?? []) {
    const file = aliasOf.get(join(top, path)) ?? join(top, path);
    if (isGenerated(toProject(file))) continue;
    const input = graph.live.get(graph.fileKey(file));
    // `.env.local` on a laptop: CI checks out no such file, and git mode cannot compare it either way.
    if (input && parseNodeId(input.via).kind === 'I' && basename(file).startsWith('.env')) {
      warnings.push(`${graph.fileKey(file)}: ignored by git, so git mode does not compare it`);
      continue;
    }
    reasons.push({
      kind: input && parseNodeId(input.via).kind === 'I' ? 'input' : 'source',
      key: graph.fileKey(file),
      detail: 'is ignored by git, so git mode cannot compare it (list generated files under "generated" in byakugan.json)',
      chain: input ? [] : graph.chain(nodeId('M', file)),
    });
  }
  const tailwind4 = [...graph.tailwind.values()].some(r => Number.parseInt(r.version ?? '0', 10) >= 4);

  // `lib/util.ts` deleted while `lib/util/index.ts` is live: the import now resolves to another file.
  const liveStems = new Set<string>();
  for (const r of graph.files.values()) {
    if (isInNodeModules(r.file) || !(r.evaluated || r.used.size > 0) || !CODE_FILE.test(r.file)) continue;
    liveStems.add(stem(r.file));
    if (/^index\.[^.]+$/.test(basename(r.file))) liveStems.add(dirname(r.file));
  }

  for (const change of changes) {
    const path = aliasOf.get(join(top, change.path)) ?? join(top, change.path);
    const name = basename(path);
    const old = before.get(change.path);
    if (graph.tailwind.size > 0 && !LOCKFILES.has(name)) baseContents[path] = change.status === 'A' ? null : (old?.toString() ?? null);

    // Tailwind v4 skips the files .gitignore lists. The base-side run would read today's .gitignore.
    if (name === '.gitignore' && tailwind4) {
      reasons.push({ kind: 'source', key: change.path, detail: 'changes which files Tailwind scans for class names', chain: [] });
      continue;
    }

    if (LOCKFILES.has(name)) {
      const head = change.status === 'D' ? '' : (readText(path) ?? '');
      const a = parseLockfile(name, old?.toString() ?? '');
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
        const same = from === to ? ' (same version, different source, integrity or patch)' : '';
        reasons.push({ kind: 'dependency', key: c.name, detail: `${from} -> ${to}${same} (${files} used fragment${files === 1 ? '' : 's'})`, chain: [] });
      }
      if (used.length === 0) ignored.push({ path: change.path, fragments: [] });
      continue;
    }

    if (PATCH_FILE.test(change.path)) {
      const pkg = patchedPackage(change.path);
      if (pkg === undefined || usedPackages.has(pkg)) {
        reasons.push({ kind: 'dependency', key: pkg ?? change.path, detail: `patch ${change.path} changed`, chain: [] });
      } else ignored.push({ path: change.path, fragments: [] });
      continue;
    }

    // A submodule moved to another commit: compare nothing, count it when the graph reads inside it.
    if (change.modes.includes('160000')) {
      const inside = [...graph.files.keys()].some(f => f.startsWith(path + sep));
      if (inside) reasons.push({ kind: 'source', key: change.path, detail: 'submodule changed', chain: [] });
      else ignored.push({ path: change.path, fragments: [] });
      continue;
    }

    // A symlink added, removed or retargeted: the graph holds the files it points at, under their
    // real paths or under the link's own path. A directory link under an entry or input pattern
    // may have added or removed files the base side listed through it.
    // An untracked link carries no mode, so the working tree is asked too.
    if (change.modes.includes('120000') || isLink(path)) {
      const oldTarget = old ? resolve(dirname(path), old.toString()) : undefined;
      const newTarget = existsSync(path) ? realpathSync(path) : undefined;
      const reads = [oldTarget, newTarget, path].some(t => t !== undefined && [...graphFiles].some(f => f === t || f.startsWith(t + sep)));
      const lists = (oldTarget !== undefined && linkMatters(path, oldTarget)) || (newTarget !== undefined && isDirectory(newTarget) && linkMatters(path, newTarget));
      if (reads || lists) {
        reasons.push({ kind: 'source', key: change.path, detail: 'symlink changed', chain: [] });
        continue;
      }
    }

    const inputKey = graph.fileKey(path);
    const input = graph.live.get(inputKey);
    if (input && parseNodeId(input.via).kind === 'I') {
      const beforeHash = old === undefined ? undefined : graph.inputHashOf(path, old);
      if (beforeHash !== input.hash) reasons.push({ kind: 'input', key: inputKey, detail: old === undefined ? 'added' : 'changed', chain: [] });
      else ignored.push({ path: change.path, fragments: [] });
      continue;
    }
    const linked = change.status === 'D' ? viaLinks(path) : [];
    const deletedInput = [path, ...linked].find(p => inProject(p) && isInput(toProject(p)));
    if (change.status === 'D' && deletedInput) {
      reasons.push({ kind: 'input', key: graph.fileKey(deletedInput), detail: 'deleted', chain: [] });
      continue;
    }

    let file = path;
    let head = graph.module(file);
    // `git mv Hero.tsx hero.tsx` on macOS: the graph still reads Hero.tsx, but Linux would not find it.
    if (head && change.status === 'D' && !exactCase(file, top)) {
      reasons.push({ kind: 'source', key: graph.fileKey(file), detail: 'renamed by case only; imports that use the old case fail on case-sensitive file systems', chain: [] });
      continue;
    }
    if (!head && !isInNodeModules(file)) {
      // yarn `file:` and pnpm `injected` copy a workspace package into node_modules.
      const copy = graph.installedCopy(file);
      if (copy) {
        file = copy;
        head = graph.module(copy);
      }
    }
    if (!head) {
      if (change.status === 'D') {
        const where =
          [file, ...linked].some(p => inProject(p) && isEntry(toProject(p)))
            ? 'it was an entry'
            : project.namedFiles.includes(file)
              ? 'a config file names it'
              : (pointedAt(graph, file) ??
                (typeImportOf(graph, file) ? 'an import type named it and no longer resolves' : undefined) ??
                (CODE_FILE.test(file) && liveStems.has(stem(file)) ? 'an import that resolved to it now resolves to another file' : undefined));
        if (where) {
          reasons.push({ kind: 'source', key: graph.fileKey(file), detail: `deleted (${where})`, chain: [] });
          continue;
        }
      }
      ignored.push({ path: change.path, fragments: [] });
      continue;
    }

    const baseModule = old === undefined ? undefined : loadModule(file, old, graph.parseOptions).module;
    const baseFragments = baseModule ? moduleFragments(baseModule) : new Map<string, string>();
    const headFragments = moduleFragments(head);
    const fileKey = graph.fileKey(file);
    const changed: string[] = [];
    let live = false;
    for (const id of new Set([...baseFragments.keys(), ...headFragments.keys()])) {
      if (baseFragments.get(id) === headFragments.get(id)) continue;
      changed.push(id);
      const fragment = graph.live.get(fragmentKey(fileKey, id));
      if (!fragment) {
        // Not live now, but it may have been: a removed export something still imports, an `export` keyword dropped.
        const wanted = graph.wants(file, id, baseModule);
        if (wanted === undefined) continue;
        live = true;
        reasons.push({ kind: 'source', key: fragmentKey(fileKey, id), detail: headFragments.has(id) ? 'changed' : 'removed', chain: graph.chain(wanted) });
        continue;
      }
      live = true;
      const detail = baseFragments.has(id) ? 'changed' : 'added';
      reasons.push({ kind: 'source', key: fragment.key, detail, chain: graph.chain(fragment.via) });
    }
    const raw = graph.live.get(fragmentKey(fileKey, '<raw>'));
    if (raw && hashOf(old ?? '') !== raw.hash) {
      live = true;
      reasons.push({ kind: 'source', key: raw.key, detail: 'changed (imported with ?raw)', chain: graph.chain(raw.via) });
    }
    // Only when nothing else in the file counted: reordered bare imports already change `<module>`.
    if (!live && graph.isEvaluated(file) && head.kind === 'esm') {
      for (const detail of requestChanges(graph, file, baseModule, head, side)) {
        live = true;
        reasons.push({ kind: 'source', key: fragmentKey(fileKey, '<imports>'), detail, chain: graph.chain(nodeId('M', file)) });
      }
    }
    if (!live) ignored.push({ path: change.path, fragments: changed });
  }

  if (Object.keys(baseContents).length > 0) {
    const roots = [...graph.tailwind.values()].filter(r => r.hash !== undefined);
    const results = roots.length > 0 ? runTailwind(graph.tailwindRequest(roots.map(r => r.file), baseContents)) : [];
    for (const result of results) {
      const head = graph.tailwind.get(result.file);
      if (!head || result.hash === head.hash) continue;
      const scanned = new Set([...head.files, ...result.files]);
      const sources = Object.keys(baseContents).filter(f => scanned.has(f) || !existsSync(f));
      const paths = new Set(sources.map(f => relative(top, f).split(sep).join('/')));
      reasons.push({
        kind: 'source',
        key: `${graph.fileKey(result.file)}#<tailwind>`,
        detail: result.hash === undefined ? `cannot run Tailwind on the base side (${result.error})` : `generated CSS changes (${[...paths].join(', ')})`,
        chain: graph.chain(nodeId('M', result.file)),
      });
      for (let i = ignored.length - 1; i >= 0; i--) if (paths.has(ignored[i].path)) ignored.splice(i, 1);
    }
  }

  return { affected: reasons.length > 0, fingerprint: graph.fingerprint(), base: commit, reasons, ignored, warnings };
};

/**
 * A deleted file that an `import type` named. The head graph only warns about a type import that
 * does not resolve, so without this the types the base side read from the file vanish unseen.
 */
const typeImportOf = (graph: UsageGraph, file: string): boolean =>
  graph.unresolved.some(u => {
    if (!u.type) return false;
    const bases = u.specifier.startsWith('.') ? [resolve(dirname(u.from), u.specifier)] : graph.project.aliasTargets(u.specifier);
    return bases.some(b => file === b || stem(file) === b || stem(file) === stem(b) || (dirname(file) === b && basename(file).startsWith('index.')));
  });

/** Why a deleted file still mattered: a computed import, a directory the code reads, or a path in the code. */
const pointedAt = (graph: UsageGraph, file: string): string | undefined => {
  const path = file.split(sep).join('/');
  if (graph.patterns.missing.has(file)) return 'the code refers to this path';
  if (graph.patterns.shadowed.has(stem(file)) || graph.patterns.shadowed.has(dirname(file))) return 'an alias import that resolved to it now resolves to another target';
  if (graph.patterns.contexts.some(matches => matches(path))) return 'matches a computed import';
  if (graph.patterns.trees.some(dir => file.startsWith(dir + sep))) return 'inside a directory the code reads';
};

