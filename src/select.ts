import type { AffectedReason } from './affected.ts';
import { parseNodeId, type UsageGraph } from './graph.ts';
import { globMatcher, safeGlob } from './glob.ts';
import { isConfigEntry, type Project } from './project.ts';

const CONFIG_EXT = '{ts,mts,cts,js,mjs,cjs}';

/** Test runner configs and setup files: every test loads them, so a change there reaches them all. */
const RUNNER_FILES = [
  `{vitest,vite,jest,playwright}.config.${CONFIG_EXT}`,
  `vitest.{workspace,setup}.${CONFIG_EXT}`,
  `{jest,test}.setup.${CONFIG_EXT}`,
  `setupTests.${CONFIG_EXT}`,
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
