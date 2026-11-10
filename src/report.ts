import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AffectedResult } from './affected.ts';
import { parseNodeId, type UsageGraph } from './graph.ts';
import { isInNodeModules } from './resolve.ts';
import { PLAIN, type Line, type Style } from './ui.ts';

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
  /** Environment variables live code reads by name, and the ones whose values are in the fingerprint. */
  env: { read: string[]; counted: string[] };
  unresolved: Array<{ specifier: string; from: string }>;
  warnings: string[];
  stats: { projectFiles: number; packageFiles: number; packages: number; liveFragments: number };
}

/**
 * File names and specifiers come from the repository. Escape control characters so a
 * name holding ESC sequences cannot rewrite the terminal or a CI log.
 */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
export const safe = (text: string) => text.replace(CONTROL, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const clean = (text: string) => safe(text.replace(/[\r\n]/g, ' '));
/** Escapes every piece, then paints it, so repository text can never hold an escape sequence. */
const lines = (out: Line[], style: Style = PLAIN) =>
  out
    .map(line => (typeof line === 'string' ? clean(line) : line.map(part => (typeof part === 'string' ? clean(part) : style.paint(part[0], clean(part[1])))).join('')))
    .join('\n');

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
    env: {
      read: [...graph.env.keys()].filter(k => k !== '*').sort(),
      counted: [...graph.live.keys()].filter(k => k.startsWith('env:')).map(k => k.slice(4)).sort(),
    },
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

export const formatGraph = (summary: GraphSummary, style: Style = PLAIN): string => {
  const out: Line[] = [];
  const heading = (text: string): Line => [[['bold', 'cyan'], text]];
  const s = summary.stats;
  out.push([['bold', 'byakugan'], ` · ${summary.framework} · ${summary.entries.length} entries`]);
  out.push(
    `${s.projectFiles} project files · ${s.packageFiles} files in ${s.packages} packages · ${s.liveFragments} live fragments`
  );
  out.push([['dim', 'fingerprint '], summary.fingerprint], '');

  out.push(heading('entries'));
  for (const e of summary.entries) out.push(`  ${e}`);

  const width = Math.min(60, Math.max(20, ...summary.files.map(f => f.key.length + 4)));
  out.push('', heading('project files'));
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
    out.push([`  ${pad(f.key, width)}`, [f.used.length === 0 && f.kind !== 'opaque' ? 'yellow' : 'dim', what]]);
  }

  if (summary.packages.length > 0) {
    out.push('', heading('packages'));
    const nameWidth = Math.min(40, Math.max(...summary.packages.map(p => p.name.length + p.version.length + 5)));
    for (const p of summary.packages) {
      const files = `${p.files.length} file${p.files.length === 1 ? '' : 's'}`;
      const imports = p.imports.filter(i => i !== '*');
      out.push([`  ${pad(`${p.name}@${p.version}`, nameWidth)}`, ['dim', `${pad(files, 11)}${list(imports)}`]]);
    }
  }

  if (summary.tracked.length > 0) out.push('', [[['bold', 'cyan'], 'tracked by version'], `  ${summary.tracked.join(', ')}`]);
  if (summary.inputs.length > 0) out.push('', [[['bold', 'cyan'], 'inputs'], `  ${list(summary.inputs, 8)}`]);
  if (summary.env.read.length > 0) {
    out.push('', [[['bold', 'cyan'], 'env read'], `  ${list(summary.env.read, 8)}`]);
    out.push([[['bold', 'cyan'], 'env values counted'], `  ${summary.env.counted.length > 0 ? list(summary.env.counted, 8) : 'none (list them under "env" in byakugan.json)'}`]);
  }
  if (summary.unresolved.length > 0) {
    out.push('', [[['bold', 'yellow'], 'unresolved']]);
    for (const u of summary.unresolved) out.push(`  ${u.specifier}  (from ${u.from})`);
  }
  if (summary.warnings.length > 0) {
    out.push('', [[['bold', 'yellow'], 'warnings']]);
    for (const w of summary.warnings) out.push([['yellow', `  ${w}`]]);
    out.push('', [['dim', 'Run "byakugan doctor" for what each warning costs and how to fix it.']]);
  }
  return lines(out, style);
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

/** Mermaid strings: entity codes for quotes and backticks, no line breaks (a new line could start a `click` directive). */
const mermaidText = (text: string) =>
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/#/g, '#35;').replace(/"/g, '#quot;').replace(/`/g, '#96;').replace(/</g, '#lt;').replace(/>/g, '#gt;');

export const formatMermaid = (graph: UsageGraph): string => {
  const { nodes, edges } = collapsedEdges(graph);
  const ids = new Map<string, string>();
  const out = ['graph LR'];
  for (const [key, kind] of nodes) {
    const id = toId(key, ids);
    const label = mermaidText(key);
    out.push(kind === 'package' ? `  ${id}[["${label}"]]` : `  ${id}["${label}"]`);
  }
  for (const e of edges) out.push(`  ${toId(e.from, ids)} -->|"${mermaidText(edgeLabel(e.names))}"| ${toId(e.to, ids)}`);
  return out.join('\n');
};

const dotText = (text: string) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

export const formatDot = (graph: UsageGraph): string => {
  const { nodes, edges } = collapsedEdges(graph);
  const out = ['digraph byakugan {', '  rankdir=LR;', '  node [shape=box, fontname="Helvetica"];'];
  for (const [key, kind] of nodes) out.push(`  "${dotText(key)}"${kind === 'package' ? ' [shape=component]' : ''};`);
  for (const e of edges) out.push(`  "${dotText(e.from)}" -> "${dotText(e.to)}" [label="${dotText(edgeLabel(e.names))}"];`);
  out.push('}');
  return out.join('\n');
};

export const formatAffected = (graph: UsageGraph, result: AffectedResult, verbose = false, style: Style = PLAIN): string => {
  const out: Line[] = [];
  const yes: Line = style.on ? [[['bold', 'yellow'], '● affected']] : ['affected'];
  const no: Line = style.on ? [[['bold', 'green'], '✔ unaffected']] : ['unaffected'];
  const base = result.base ? ` since ${result.base.slice(0, 12)}` : ' since the base manifest';
  const n = result.reasons.length;
  if (result.affected) out.push([...yes, `${base}: ${n} change${n === 1 ? ' reaches' : 's reach'} the app`]);
  else if (result.base) {
    const files = result.ignored.length;
    out.push([...no, `${base}: ${files} changed file${files === 1 ? '' : 's'}, none of it reaches the app`]);
  } else out.push([...no, `${base}: every used fragment matches`]);
  out.push([['dim', 'fingerprint '], result.fingerprint]);
  const shown = verbose ? result.reasons : result.reasons.slice(0, 20);
  for (const r of shown) {
    out.push('', [['bold', `${r.kind}:`], ` ${r.key} ${r.detail}`]);
    // A loop, not a spread: chains can be hundreds of thousands of steps long.
    if (r.chain.length > 0) for (const line of formatChain(graph, r.chain, '    ')) out.push([['dim', line]]);
  }
  if (shown.length < result.reasons.length) out.push('', `… ${result.reasons.length - shown.length} more (use --verbose)`);
  if (result.ignored.length > 0) {
    out.push('', [[['bold', 'cyan'], 'changes nothing uses']]);
    for (const i of verbose ? result.ignored : result.ignored.slice(0, 20)) {
      out.push([`  ${i.path}`, ['dim', i.fragments.length > 0 ? `  (${list(i.fragments, 4)})` : '']]);
    }
    if (!verbose && result.ignored.length > 20) out.push(`  … ${result.ignored.length - 20} more (use --verbose)`);
  }
  if (result.warnings.length > 0) {
    out.push('', [[['bold', 'yellow'], 'warnings']]);
    for (const w of result.warnings) out.push([['yellow', `  ${w}`]]);
  }
  return lines(out, style);
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

export const formatWhy = (graph: UsageGraph, result: WhyResult, style: Style = PLAIN): string => {
  if (result.matches.length === 0) {
    return lines([
      result.loaded ? `${result.query}: loaded (for example through a barrel), but none of its code is used` : `${result.query}: not used by the app`,
    ]);
  }
  const out: Line[] = [];
  for (const m of result.matches) {
    if (out.length > 0) out.push('');
    out.push([['bold', m.key]]);
    for (const line of formatChain(graph, m.chain, '  ')) out.push([['dim', line]]);
  }
  return lines(out, style);
};
