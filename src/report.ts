import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AffectedResult } from './affected.ts';
import { parseNodeId, type UsageGraph } from './graph.ts';
import { isInNodeModules } from './resolve.ts';

export interface FileSummary {
  key: string;
  kind: string;
  /** Why an opaque file is hashed whole: `commonjs`, `asset`, `mdx` or `parse-error`. */
  reason?: string;
  evaluated: boolean;
  /** Export names in use. `*` means every export (entries, dynamic imports, CommonJS). */
  used: string[];
  exports: number;
  live: string[];
}

export interface PackageSummary {
  name: string;
  version: string;
  /** Names imported by project code. */
  imports: string[];
  files: string[];
  fragments: number;
}

export interface GraphSummary {
  root: string;
  dir: string;
  framework: string;
  fingerprint: string;
  entries: string[];
  inputs: string[];
  files: FileSummary[];
  packages: PackageSummary[];
  tracked: string[];
  unresolved: Array<{ specifier: string; from: string }>;
  warnings: string[];
  stats: { projectFiles: number; packageFiles: number; packages: number; liveFragments: number };
}

const byKey = <T extends { key: string }>(a: T, b: T) => a.key.localeCompare(b.key);

export const summarize = (graph: UsageGraph): GraphSummary => {
  const liveByFile = new Map<string, string[]>();
  for (const fragment of graph.live.values()) {
    if (!fragment.file) continue;
    const list = liveByFile.get(fragment.file);
    const id = fragment.key.includes('#') ? fragment.key.slice(fragment.key.indexOf('#') + 1) : '<file>';
    if (list) list.push(id);
    else liveByFile.set(fragment.file, [id]);
  }

  const files: FileSummary[] = [];
  const packages = new Map<string, PackageSummary>();
  for (const record of graph.files.values()) {
    const live = liveByFile.get(record.file) ?? [];
    if (!record.evaluated && record.used.size === 0) continue;
    if (record.package && isInNodeModules(record.file)) {
      let pkg = packages.get(record.package.name);
      if (!pkg) {
        pkg = {
          name: record.package.name,
          version: record.package.version,
          imports: [...(graph.packageImports.get(record.package.name) ?? [])].sort(),
          files: [],
          fragments: 0,
        };
        packages.set(pkg.name, pkg);
      }
      if (live.length > 0) pkg.files.push(record.key.slice(`npm:${record.package.name}/`.length));
      pkg.fragments += live.length;
      continue;
    }
    files.push({
      key: record.key,
      kind: record.kind,
      reason: record.reason,
      evaluated: record.evaluated,
      used: [...record.used].sort(),
      exports: record.kind === 'esm' ? graph.exportNames(record.file).size : 0,
      live: live.sort(),
    });
  }

  const tracked: string[] = [];
  const inputs: string[] = [];
  for (const fragment of graph.live.values()) {
    if (parseNodeId(fragment.via).kind !== 'I') continue;
    if (fragment.key.endsWith('#<version>')) tracked.push(fragment.key.slice(4, -'#<version>'.length));
    else inputs.push(fragment.key);
  }

  const packageList = [...packages.values()].filter(p => p.fragments > 0).sort((a, b) => a.name.localeCompare(b.name));
  for (const p of packageList) p.files.sort();
  return {
    root: graph.project.root,
    dir: graph.project.dir,
    framework: graph.project.framework,
    fingerprint: graph.fingerprint(),
    entries: graph.project.entries.map(e => graph.fileKey(e)),
    inputs: inputs.sort(),
    files: files.sort(byKey),
    packages: packageList,
    tracked: tracked.sort(),
    unresolved: graph.unresolved.map(u => ({ specifier: u.specifier, from: graph.fileKey(u.from) })),
    warnings: graph.warnings,
    stats: {
      projectFiles: files.length,
      packageFiles: packageList.reduce((n, p) => n + p.files.length, 0),
      packages: packageList.length,
      liveFragments: graph.live.size,
    },
  };
};

const list = (names: string[], max = 6) =>
  names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} +${names.length - max} more`;

const pad = (s: string, n: number) => (s.length >= n ? `${s}  ` : s + ' '.repeat(n - s.length));

export const formatGraph = (summary: GraphSummary): string => {
  const out: string[] = [];
  const s = summary.stats;
  out.push(`byakugan · ${summary.framework} · ${summary.entries.length} entries`);
  out.push(
    `${s.projectFiles} project files · ${s.packageFiles} files in ${s.packages} packages · ${s.liveFragments} live fragments`
  );
  out.push(`fingerprint ${summary.fingerprint}`, '');

  out.push('entries');
  for (const e of summary.entries) out.push(`  ${e}`);

  const width = Math.min(60, Math.max(20, ...summary.files.map(f => f.key.length + 4)));
  out.push('', 'project files');
  for (const f of summary.files) {
    let what: string;
    if (f.kind === 'opaque') what = `whole file (${f.reason})`;
    else if (f.used.includes('*')) what = `all ${f.exports} exports`;
    else if (f.used.length > 0) {
      const counts = f.exports > 0 ? `${f.used.length} of ${f.exports} exports` : '';
      const note = [counts, f.evaluated ? '' : 'types only'].filter(Boolean).join(', ');
      what = `${list(f.used)}${note ? `  (${note})` : ''}`;
    }
    else what = f.live.length > 0 ? 'runs (side effects only)' : `runs, nothing used${f.exports > 0 ? ` (0 of ${f.exports} exports)` : ''}`;
    out.push(`  ${pad(f.key, width)}${what}`);
  }

  if (summary.packages.length > 0) {
    out.push('', 'packages');
    const nameWidth = Math.min(40, Math.max(...summary.packages.map(p => p.name.length + p.version.length + 5)));
    for (const p of summary.packages) {
      const files = `${p.files.length} file${p.files.length === 1 ? '' : 's'}`;
      const imports = p.imports.filter(i => i !== '*');
      out.push(`  ${pad(`${p.name}@${p.version}`, nameWidth)}${pad(files, 11)}${list(imports)}`);
    }
  }

  if (summary.tracked.length > 0) out.push('', `tracked by version  ${summary.tracked.join(', ')}`);
  if (summary.inputs.length > 0) out.push('', `inputs  ${list(summary.inputs, 8)}`);
  if (summary.unresolved.length > 0) {
    out.push('', 'unresolved');
    for (const u of summary.unresolved) out.push(`  ${u.specifier}  (from ${u.from})`);
  }
  if (summary.warnings.length > 0) {
    out.push('', 'warnings');
    for (const w of summary.warnings) out.push(`  ${w}`);
  }
  return out.join('\n');
};

/** One line per graph node: `app/page.tsx (entry)`, `lib/utils.ts#cn`, `npm:lodash/partition.js (runs)`. */
export const describeNode = (graph: UsageGraph, id: string): string => {
  const { kind, file, name } = parseNodeId(id);
  if (kind === 'I') return `${file.startsWith('npm:') ? file : graph.fileKey(file)} (input)`;
  const key = graph.fileKey(file);
  if (kind === 'M') return `${key} (runs)`;
  if (kind === 'S') {
    if (name === '*') return graph.parents.get(id) === null ? `${key} (entry)` : `${key} › all exports`;
    return `${key} › ${name}`;
  }
  if (kind === 'T') return name === '*' ? `${key} › all exports (types)` : `${key} › ${name} (type)`;
  const module = graph.module(file);
  const binding = module?.kind === 'esm' ? module.imports.get(name) : undefined;
  const suffix = kind === 'Y' ? ' (type)' : '';
  return binding ? `${key}#${name} (${binding.type ? 'type ' : ''}import from "${binding.source}")${suffix}` : `${key}#${name}${suffix}`;
};

/** Drops `file › name` steps that are followed by the same file's binding or evaluation. */
export const formatChain = (graph: UsageGraph, chain: string[], indent = '  '): string[] => {
  const out: string[] = [];
  chain.forEach((id, i) => {
    const current = parseNodeId(id);
    const next = i + 1 < chain.length ? parseNodeId(chain[i + 1]) : undefined;
    const isEntry = i === 0;
    const exportStep = current.kind === 'S' || current.kind === 'T';
    if (!isEntry && exportStep && next && next.file === current.file && ['D', 'M', 'Y'].includes(next.kind)) return;
    out.push(`${indent}${out.length === 0 ? '' : '└ '}${describeNode(graph, id)}`);
  });
  return out;
};

const toId = (key: string, ids: Map<string, string>) => {
  let id = ids.get(key);
  if (!id) {
    id = `n${ids.size}`;
    ids.set(key, id);
  }
  return id;
};

interface CollapsedEdge {
  from: string;
  to: string;
  names: Set<string>;
}

const collapsedEdges = (graph: UsageGraph): { nodes: Map<string, 'file' | 'package'>; edges: CollapsedEdge[] } => {
  const nodes = new Map<string, 'file' | 'package'>();
  const edges = new Map<string, CollapsedEdge>();
  const label = (file: string): string => {
    const record = graph.files.get(file);
    if (record?.package && isInNodeModules(file)) {
      nodes.set(record.package.name, 'package');
      return record.package.name;
    }
    const key = graph.fileKey(file);
    nodes.set(key, 'file');
    return key;
  };
  for (const [from, targets] of graph.edges) {
    const a = label(from);
    for (const [to, names] of targets) {
      const b = label(to);
      if (a === b || nodes.get(a) === 'package') continue;
      const k = `${a}\0${b}`;
      const edge = edges.get(k);
      if (edge) for (const n of names) edge.names.add(n);
      else edges.set(k, { from: a, to: b, names: new Set(names) });
    }
  }
  for (const [name, kind] of nodes) {
    if (kind !== 'package') continue;
    if (![...edges.values()].some(e => e.to === name)) nodes.delete(name);
  }
  return { nodes, edges: [...edges.values()] };
};

const edgeLabel = (names: Set<string>) => list([...names].map(n => (n === '*' ? 'all' : n)).sort(), 3);

export const formatMermaid = (graph: UsageGraph): string => {
  const { nodes, edges } = collapsedEdges(graph);
  const ids = new Map<string, string>();
  const out = ['graph LR'];
  for (const [key, kind] of nodes) {
    const id = toId(key, ids);
    out.push(kind === 'package' ? `  ${id}[["${key}"]]` : `  ${id}["${key}"]`);
  }
  for (const e of edges) out.push(`  ${toId(e.from, ids)} -->|"${edgeLabel(e.names)}"| ${toId(e.to, ids)}`);
  return out.join('\n');
};

export const formatDot = (graph: UsageGraph): string => {
  const { nodes, edges } = collapsedEdges(graph);
  const out = ['digraph byakugan {', '  rankdir=LR;', '  node [shape=box, fontname="Helvetica"];'];
  for (const [key, kind] of nodes) out.push(`  "${key}"${kind === 'package' ? ' [shape=component]' : ''};`);
  for (const e of edges) out.push(`  "${e.from}" -> "${e.to}" [label="${edgeLabel(e.names)}"];`);
  out.push('}');
  return out.join('\n');
};

export const formatAffected = (graph: UsageGraph, result: AffectedResult, verbose = false): string => {
  const out: string[] = [];
  const base = result.base ? ` since ${result.base.slice(0, 12)}` : ' since the base manifest';
  const n = result.reasons.length;
  if (result.affected) out.push(`affected${base}: ${n} change${n === 1 ? ' reaches' : 's reach'} the app`);
  else if (result.base) {
    const files = result.ignored.length;
    out.push(`unaffected${base}: ${files} changed file${files === 1 ? '' : 's'}, none of it reaches the app`);
  } else out.push(`unaffected${base}: every used fragment matches`);
  out.push(`fingerprint ${result.fingerprint}`);
  const shown = verbose ? result.reasons : result.reasons.slice(0, 20);
  for (const r of shown) {
    out.push('', `${r.kind}: ${r.key} ${r.detail}`);
    if (r.chain.length > 0) out.push(...formatChain(graph, r.chain, '    '));
  }
  if (shown.length < result.reasons.length) out.push('', `… ${result.reasons.length - shown.length} more (use --verbose)`);
  if (result.ignored.length > 0) {
    out.push('', 'changes nothing uses');
    for (const i of verbose ? result.ignored : result.ignored.slice(0, 20)) {
      out.push(`  ${i.path}${i.fragments.length > 0 ? `  (${list(i.fragments, 4)})` : ''}`);
    }
    if (!verbose && result.ignored.length > 20) out.push(`  … ${result.ignored.length - 20} more`);
  }
  return out.join('\n');
};

export interface WhyMatch {
  key: string;
  chain: string[];
}

export interface WhyResult {
  query: string;
  matches: WhyMatch[];
  /** The file was read (e.g. a barrel sibling) but none of its code is used. */
  loaded: boolean;
}

/** `file`, `file#name`, `npm:pkg/file` or a bare package name. Paths may be relative to `cwd`. */
export const why = (graph: UsageGraph, query: string, cwd = process.cwd(), limit = 5): WhyResult => {
  const hash = query.indexOf('#');
  const path = hash === -1 ? query : query.slice(0, hash);
  const fragment = hash === -1 ? undefined : query.slice(hash + 1);
  let key = path;
  let file: string | undefined;
  for (const base of [cwd, graph.project.dir, graph.project.root]) {
    const candidate = resolve(base, path);
    if (path && existsSync(candidate)) {
      file = realpathSync(candidate);
      key = graph.fileKey(file);
      break;
    }
  }
  const pkg = !file && !key.startsWith('npm:') && /^(@[^/]+\/)?[^/.][^/]*$/.test(key) ? key : undefined;
  const matches: WhyMatch[] = [];
  for (const f of graph.live.values()) {
    const hit = fragment !== undefined
      ? f.key === `${key}#${fragment}`
      : f.key === key || f.key.startsWith(`${key}#`) || (pkg !== undefined && (f.key.startsWith(`npm:${pkg}/`) || f.key.startsWith(`npm:${pkg}#`)));
    if (!hit) continue;
    matches.push({ key: f.key, chain: graph.chain(f.via) });
    if (matches.length >= limit) break;
  }
  const loaded = file !== undefined && graph.files.has(file);
  return { query, matches, loaded };
};

export const formatWhy = (graph: UsageGraph, result: WhyResult): string => {
  if (result.matches.length === 0) {
    return result.loaded
      ? `${result.query}: loaded (for example through a barrel), but none of its code is used`
      : `${result.query}: not used by the app`;
  }
  const out: string[] = [];
  for (const m of result.matches) {
    if (out.length > 0) out.push('');
    out.push(`${m.key}`);
    out.push(...formatChain(graph, m.chain, '  '));
  }
  return out.join('\n');
};
