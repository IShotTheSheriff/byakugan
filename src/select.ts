import { createHash } from 'node:crypto';
import { manifestMismatch, type AffectedReason, type Manifest } from './affected.ts';
import { parseNodeId, type UsageGraph } from './graph.ts';
import { globMatcher, safeGlob } from './glob.ts';
import { isConfigEntry, type Project } from './project.ts';

const CONFIG_EXT = '{ts,mts,cts,js,mjs,cjs}';

/** Test runner and Storybook configs and setup files: every test or story loads them, so a change there reaches them all. */
const RUNNER_FILES = [
  `{vitest,vite,jest,playwright}.config.${CONFIG_EXT}`,
  `vitest.{workspace,setup}.${CONFIG_EXT}`,
  `{jest,test}.setup.${CONFIG_EXT}`,
  `setupTests.${CONFIG_EXT}`,
  // Storybook loads main and preview for every story: decorators, global styles, addons.
  '.storybook/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
];

export interface EachProject {
  project: Project;
  /** Files `patterns` match: one verdict each. */
  each: string[];
}

/**
 * The project with the files `patterns` match as its entries, for one verdict per file, such as
 * per test or per story. Framework routes are dropped, since a test does not load them. Config
 * entries and test runner files stay: every matched file depends on them.
 */
export const eachProject = (project: Project, patterns: string[]): EachProject => {
  const ignore = ['**/node_modules/**', '**/.git/**'];
  const each = safeGlob(patterns, { cwd: project.dir, boundary: project.repo, ignore }).sort();
  const runner = safeGlob(RUNNER_FILES, { cwd: project.dir, boundary: project.repo, ignore });
  const shared = [...project.entries.filter(isConfigEntry), ...runner].filter(f => !each.includes(f));
  return {
    project: {
      ...project,
      entries: [...new Set([...each, ...shared])].sort(),
      entryPatterns: [...project.entryPatterns, ...patterns, ...RUNNER_FILES],
    },
    each,
  };
};

export interface EachResult {
  /** A change reaches every file, through a config, an input or something with no chain. */
  all: boolean;
  /** Matched files a change reaches, relative keys, sorted. All of them when `all`. */
  files: string[];
}

/**
 * Which of `each` the reasons reach. Walks the graph backwards from each changed fragment, over
 * every node that reached it, not only the first, up to the roots. A root that is one of `each`
 * is reached, and the walk goes on past it, since another matched file may import it; any other root (a config entry, an input, a tracked package version) reaches all.
 */
export const entriesReaching = (graph: UsageGraph, reasons: AffectedReason[], each: string[], patterns: string[]): EachResult => {
  const eachSet = new Set(each);
  const matches = globMatcher(patterns.map(p => p.replace(/^\.\//, '')));
  const everything = (): EachResult => ({ all: true, files: each.map(f => graph.fileKey(f)).sort() });
  const reached = new Set<string>();
  const seen = new Set<string>();
  for (const reason of reasons) {
    // A deleted test file needs no run.
    if (reason.detail.startsWith('deleted') && matchesProjectPath(graph, reason.key, matches)) continue;
    const starts = startNodes(graph, reason);
    if (!starts) return everything();
    const stack = [...starts];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      if (graph.parents.get(id) === null) {
        const { kind, file } = parseNodeId(id);
        if (kind === 'S' && eachSet.has(file)) reached.add(file);
        else return everything();
        // A test that another test imports is a root and a dependency at once: keep walking.
      }
      for (const from of graph.reachedFrom.get(id) ?? []) stack.push(from);
    }
  }
  return { all: false, files: [...reached].map(f => graph.fileKey(f)).sort() };
};

/** `reason.key` is a repository-relative key; `patterns` are relative to the project directory. */
const matchesProjectPath = (graph: UsageGraph, key: string, matches: (path: string) => boolean) => {
  const prefix = graph.fileKey(graph.project.dir);
  const path = prefix && key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : key;
  return matches(path);
};

/** Graph nodes a reason starts from, or undefined when it has none and so reaches everything. */
const startNodes = (graph: UsageGraph, reason: AffectedReason): string[] | undefined => {
  const vias = graph.fragmentVias.get(reason.key);
  if (vias) return [...vias];
  if (reason.chain.length > 0) return [reason.chain[reason.chain.length - 1]];
  if (reason.kind === 'dependency') {
    const out: string[] = [];
    for (const [key, set] of graph.fragmentVias) if (key.startsWith(`npm:${reason.key}/`) || key.startsWith(`npm:${reason.key}#`)) out.push(...set);
    return out.length > 0 ? out : undefined;
  }
};

/**
 * Per matched file, a fingerprint of the fragments that file reaches: its own slice of the graph.
 * A fragment that a config entry, an input or a tracked package version reaches belongs to every
 * file, as in `entriesReaching`.
 *
 * Root sets flow forward over the graph as bitsets, one bit per matched file plus one for "every
 * file", until nothing changes. Then each fragment joins the fingerprint of every file whose bit
 * one of its vias holds.
 */
export const eachFingerprints = (graph: UsageGraph, each: string[]): Record<string, string> => {
  const index = new Map(each.map((file, i) => [file, i]));
  const everyone = each.length;
  const words = (each.length + 32) >>> 5;
  const sets = new Map<string, Uint32Array>();
  const setOf = (id: string) => {
    let set = sets.get(id);
    if (!set) sets.set(id, (set = new Uint32Array(words)));
    return set;
  };
  const forward = new Map<string, string[]>();
  for (const [id, froms] of graph.reachedFrom) {
    for (const from of froms) {
      const list = forward.get(from);
      if (list) list.push(id);
      else forward.set(from, [id]);
    }
  }
  const work: string[] = [];
  for (const [id, parent] of graph.parents) {
    if (parent !== null) continue;
    const { kind, file } = parseNodeId(id);
    const bit = kind === 'S' ? (index.get(file) ?? everyone) : everyone;
    setOf(id)[bit >>> 5] |= 1 << (bit & 31);
    work.push(id);
  }
  while (work.length > 0) {
    const id = work.pop() as string;
    const from = setOf(id);
    for (const to of forward.get(id) ?? []) {
      const set = setOf(to);
      let grew = false;
      for (let w = 0; w < words; w++) {
        const next = set[w] | from[w];
        if (next !== set[w]) {
          set[w] = next;
          grew = true;
        }
      }
      if (grew) work.push(to);
    }
  }
  const hashes = each.map(() => createHash('sha256'));
  const merged = new Uint32Array(words);
  for (const key of [...graph.live.keys()].sort()) {
    merged.fill(0);
    for (const via of graph.fragmentVias.get(key) ?? []) {
      const set = sets.get(via);
      if (set) for (let w = 0; w < words; w++) merged[w] |= set[w];
    }
    const line = `${key}\0${graph.live.get(key)?.hash ?? ''}\n`;
    const all = (merged[everyone >>> 5] & (1 << (everyone & 31))) !== 0;
    for (let i = 0; i < each.length; i++) if (all || (merged[i >>> 5] & (1 << (i & 31))) !== 0) hashes[i].update(line);
  }
  return Object.fromEntries(each.map((file, i) => [graph.fileKey(file), hashes[i].digest('hex')]));
};

/**
 * Which of `each` differ from a manifest written with `hash --each`: the files whose own
 * fingerprint moved, and files the manifest does not know. Exact where `entriesReaching` has to
 * give up: a fragment a file no longer uses is gone from the graph, so no walk starts from it.
 */
export const eachSinceManifest = (graph: UsageGraph, each: string[], base: Manifest): EachResult => {
  const head = eachFingerprints(graph, each);
  const files = Object.keys(head).sort();
  // An import that does not resolve hides what is behind it from every file.
  const blind = graph.unresolved.some(u => !u.type && graph.isProjectImport(u));
  if (blind || manifestMismatch(graph, base) || !base.each) return { all: true, files };
  return { all: false, files: files.filter(file => base.each?.[file] !== head[file]) };
};
