import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compareBuilds } from './compare.ts';
import { affectedSinceCommit, affectedSinceManifest, createManifest, readManifest } from './affected.ts';
import { UsageGraph, type ModuleCache } from './graph.ts';
import { isConfigEntry, loadProject } from './project.ts';
import { describeNode, formatAffected, formatDot, formatGraph, formatMermaid, formatWhy, safe, summarize, why } from './report.ts';
import { eachFingerprints, eachProject, eachSinceManifest, entriesReaching } from './select.ts';
import { toolVersion } from './version.ts';
import { workspaceApps } from './workspace.ts';

const HELP = `byakugan: the graph of code your app actually uses

Usage
  byakugan [graph]           Print used files, exports and package files (default)
  byakugan hash              Print a fingerprint of everything the app uses
  byakugan affected          Do changes since --base (or a saved manifest) reach the app?
  byakugan why <target>      Show the import chain that makes a file, export or package used
  byakugan compare <base> <fresh>
                             Compare two build outputs (e.g. .next) without per-build noise

Options
  -C, --cwd <dir>            Project directory (default: current directory)
      --json                 JSON output
      --mermaid, --dot       Graph as Mermaid or Graphviz (graph)
      --manifest <file>      Also write per-fragment hashes to <file> (hash)
      --base <ref>           Compare with the merge base of <ref> and HEAD (affected)
      --base-manifest <file> Compare with a manifest from the base build (affected)
      --exit-code            Exit with 1 when affected, 0 when not (affected)
      --verbose              List every reason and ignored change (affected)
      --each <glob>          One verdict per matching file, e.g. per test (affected).
                             Prints the files a change reaches, one per line.
                             With hash --manifest, saves one fingerprint per file.
      --maps                 Compare source maps too (compare)
      --strict               Promise the same build output, not only the same behavior:
                             also count code the bundler ships but nothing runs.
                             Same as "mode": "strict" in byakugan.json.
      --workspace            Run hash or affected for every app in the workspace at -C.
                             --manifest and --base-manifest then name directories.
  -h, --help
  -v, --version

Targets for why: src/lib/utils.ts, src/lib/utils.ts#formatDate, lodash, npm:lodash/partition.js

In GitHub Actions, hash and affected also write fingerprint= and affected= to $GITHUB_OUTPUT,
and affected writes a summary to $GITHUB_STEP_SUMMARY. With --workspace they write apps=,
a JSON list of the affected app directories, and fingerprints=, a JSON object.`;

const version = toolVersion;

const githubOutput = (values: Record<string, string>) => {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
};

/** Chains in JSON as `describeNode` text, which holds keys, not node ids with absolute paths. */
const readableChains = <T extends { chain: string[] }>(graph: UsageGraph, items: T[]): T[] =>
  items.map(item => ({ ...item, chain: item.chain.map(id => describeNode(graph, id)) }));

/** A Markdown table for the job summary page. Cells come from the repository, so `|`, `<` and line breaks are escaped. */
const stepSummary = (rows: Array<{ app: string; affected: boolean; reason: string }>) => {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const cell = (text: string) => safe(text).replace(/[\r\n]+/g, ' ').replace(/[|<>`]/g, c => `\\${c}`);
  const out = ['| App | byakugan | First reason |', '| --- | --- | --- |'];
  for (const r of rows) out.push(`| ${cell(r.app)} | ${r.affected ? 'affected' : 'unaffected'} | ${cell(r.reason)} |`);
  appendFileSync(file, `${out.join('\n')}\n`);
};

const firstReason = (result: { affected: boolean; reasons: Array<{ kind: string; key: string; detail: string }> }) => {
  const r = result.reasons[0];
  return r ? `${r.kind}: ${r.key} ${r.detail}` : '';
};

/** File name for an app's manifest in a manifest directory: `apps/web` becomes `apps__web.json`. */
const manifestFile = (dir: string, app: string) => join(dir, `${app.replaceAll('/', '__') || 'root'}.json`);

interface Values {
  json?: boolean;
  manifest?: string;
  base?: string;
  'base-manifest'?: string;
  'exit-code'?: boolean;
  verbose?: boolean;
  strict?: boolean;
}

/** `--workspace`: one verdict per app. An app that fails to build a graph counts as affected. */
const workspaceMain = (command: string, root: string, values: Values): number => {
  const apps = workspaceApps(root, values.strict ? { mode: 'strict' } : undefined);
  // Apps share packages, so each file is parsed once for the whole run.
  const cache: ModuleCache = new Map();
  const results: Array<{ app: string; affected: boolean; fingerprint: string; reason: string; error?: string; warnings: string[] }> = [];
  for (const { path, project, error } of apps) {
    try {
      if (!project) throw new Error(error);
      const graph = new UsageGraph(project, undefined, cache).build();
      if (command === 'hash') {
        if (values.manifest) {
          mkdirSync(values.manifest, { recursive: true });
          writeFileSync(manifestFile(values.manifest, path), `${JSON.stringify(createManifest(graph), null, 2)}\n`);
        }
        results.push({ app: path, affected: true, fingerprint: graph.fingerprint(), reason: '', warnings: graph.warnings });
        continue;
      }
      const result = values['base-manifest']
        ? affectedSinceManifest(graph, readManifest(manifestFile(values['base-manifest'], path)))
        : affectedSinceCommit(graph, values.base as string);
      results.push({ app: path, affected: result.affected, fingerprint: result.fingerprint, reason: firstReason(result), warnings: result.warnings });
      if (values.verbose && !values.json) console.log(`${safe(path)}\n${formatAffected(graph, result, true)}\n`);
    } catch (error) {
      const message = String((error as Error).message ?? error);
      results.push({ app: path, affected: true, fingerprint: '', reason: `error: ${message}`, error: message, warnings: [] });
    }
  }
  const fingerprints = Object.fromEntries(results.map(r => [r.app, r.fingerprint]));
  if (command === 'hash') {
    githubOutput({ fingerprints: JSON.stringify(fingerprints) });
    if (values.json) console.log(JSON.stringify({ apps: results.map(r => ({ app: r.app, fingerprint: r.fingerprint, error: r.error, warnings: r.warnings })) }, null, 2));
    else {
      for (const r of results) warn(r.warnings.map(w => `${r.app}: ${w}`));
      const width = Math.max(...results.map(r => r.app.length)) + 2;
      for (const r of results) console.log(safe(`${r.app.padEnd(width)}${r.fingerprint || r.reason}`));
    }
    return results.some(r => r.error) ? 2 : 0;
  }
  const affectedApps = results.filter(r => r.affected).map(r => r.app);
  githubOutput({ affected: String(affectedApps.length > 0), apps: JSON.stringify(affectedApps), fingerprints: JSON.stringify(fingerprints) });
  stepSummary(results.map(r => ({ app: r.app, affected: r.affected, reason: r.reason })));
  if (values.json) console.log(JSON.stringify({ affected: affectedApps, apps: results }, null, 2));
  else if (!values.verbose) {
    const width = Math.max(...results.map(r => r.app.length)) + 2;
    for (const r of results) console.log(safe(`${r.app.padEnd(width)}${(r.affected ? 'affected' : 'unaffected').padEnd(12)}${r.reason}`.trimEnd()));
  }
  return values['exit-code'] && affectedApps.length > 0 ? 1 : 0;
};

/** Warnings go to stderr, so stdout stays a fingerprint or JSON that scripts can read. */
const warn = (warnings: string[]) => {
  for (const w of warnings) console.error(`byakugan: warning: ${safe(w.replace(/[\r\n]/g, ' '))}`);
};

const main = (argv: string[]): number => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: 'string', short: 'C' },
      json: { type: 'boolean' },
      mermaid: { type: 'boolean' },
      dot: { type: 'boolean' },
      manifest: { type: 'string' },
      base: { type: 'string' },
      'base-manifest': { type: 'string' },
      'exit-code': { type: 'boolean' },
      verbose: { type: 'boolean' },
      workspace: { type: 'boolean' },
      strict: { type: 'boolean' },
      each: { type: 'string', multiple: true },
      maps: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(version());
    return 0;
  }

  const [command = 'graph', target] = positionals;
  if (command === 'compare') {
    const [, base, fresh] = positionals;
    if (!base || !fresh) {
      console.error('Usage: byakugan compare <base build dir> <fresh build dir>');
      return 2;
    }
    const differences = compareBuilds(base, fresh, { maps: values.maps });
    if (values.json) console.log(JSON.stringify({ same: differences.length === 0, differences }, null, 2));
    else if (differences.length === 0) console.log('The builds match.');
    else console.log(safe(`The builds differ in ${differences.length} file${differences.length === 1 ? '' : 's'}:\n\n${differences.map(d => `${d.path}: ${d.detail}`).join('\n\n')}`));
    return differences.length === 0 ? 0 : 1;
  }
  if (!['graph', 'hash', 'affected', 'why'].includes(command)) {
    console.error(`Unknown command "${command}"\n\n${HELP}`);
    return 2;
  }
  if (command === 'why' && !target) {
    console.error('Usage: byakugan why <file | file#export | package>');
    return 2;
  }
  if (command === 'affected' && !values.base === !values['base-manifest']) {
    console.error('affected needs exactly one of --base <ref> or --base-manifest <file>');
    return 2;
  }

  if (values.each && ((command !== 'affected' && command !== 'hash') || values.workspace)) {
    console.error('--each works with affected and hash, without --workspace');
    return 2;
  }
  if (values.workspace) {
    if (command !== 'hash' && command !== 'affected') {
      console.error('--workspace works with hash and affected');
      return 2;
    }
    return workspaceMain(command, realpathSync(resolve(values.cwd ?? process.cwd())), values);
  }

  const loaded = loadProject({ cwd: values.cwd, config: values.strict ? { mode: 'strict' } : undefined });
  const selection = values.each ? eachProject(loaded, values.each) : undefined;
  const project = selection?.project ?? loaded;
  if (selection && selection.each.length === 0) {
    console.error(`No files in ${safe(loaded.dir)} match ${safe(values.each?.join(', ') ?? '')}`);
    return 2;
  }
  // Only config files (vite.config.ts, next.config.js) means the app's own entries were not found:
  // a fingerprint of the config alone would miss every source change.
  if (project.entries.every(isConfigEntry)) {
    console.error(`No entry files found in ${safe(project.dir)}. Add "entry" globs to byakugan.json.`);
    return 2;
  }
  const graph = new UsageGraph(project).build();

  if (command === 'graph') {
    if (values.mermaid) console.log(formatMermaid(graph));
    else if (values.dot) console.log(formatDot(graph));
    else if (values.json) console.log(JSON.stringify(summarize(graph), null, 2));
    else console.log(formatGraph(summarize(graph)));
    return 0;
  }

  if (command === 'hash') {
    const fingerprint = graph.fingerprint();
    if (values.manifest) {
      mkdirSync(dirname(values.manifest), { recursive: true });
      // With --each the manifest also holds one fingerprint per matched file.
      const each = selection ? eachFingerprints(graph, selection.each) : undefined;
      writeFileSync(values.manifest, `${JSON.stringify(createManifest(graph, each), null, 2)}\n`);
    }
    githubOutput({ fingerprint });
    if (values.json) console.log(JSON.stringify({ fingerprint, fragments: graph.live.size, warnings: graph.warnings }));
    else {
      warn(graph.warnings);
      console.log(fingerprint);
    }
    return 0;
  }

  if (command === 'why') {
    const result = why(graph, target);
    if (values.json) console.log(JSON.stringify({ ...result, matches: readableChains(graph, result.matches), warnings: graph.warnings }, null, 2));
    else {
      warn(graph.warnings);
      console.log(formatWhy(graph, result));
    }
    return 0;
  }

  const baseManifest = values['base-manifest'] ? readManifest(values['base-manifest']) : undefined;
  if (selection && baseManifest && !baseManifest.each) {
    console.error(`${safe(values['base-manifest'] ?? '')} has no per-file fingerprints. Write it with: byakugan hash --each <the same globs> --manifest <file>`);
    return 2;
  }
  const result = baseManifest ? affectedSinceManifest(graph, baseManifest) : affectedSinceCommit(graph, values.base as string);
  if (selection) {
    const reached = baseManifest ? eachSinceManifest(graph, selection.each, baseManifest) : entriesReaching(graph, result.reasons, selection.each, values.each ?? []);
    githubOutput({ affected: String(reached.files.length > 0), each: JSON.stringify(reached.files) });
    if (values.json) console.log(JSON.stringify({ ...result, reasons: readableChains(graph, result.reasons), affected: reached.files.length > 0, all: reached.all, each: reached.files }, null, 2));
    else {
      warn(result.warnings);
      const what = reached.all ? `every one of the ${selection.each.length} files: ${firstReason(result)}` : `${reached.files.length} of ${selection.each.length} files`;
      console.error(`byakugan: ${safe(what)}`);
      for (const file of reached.files) console.log(safe(file));
    }
    return values['exit-code'] && reached.files.length > 0 ? 1 : 0;
  }
  githubOutput({ affected: String(result.affected), fingerprint: result.fingerprint });
  stepSummary([{ app: graph.fileKey(project.dir) || '.', affected: result.affected, reason: firstReason(result) }]);
  console.log(values.json ? JSON.stringify({ ...result, reasons: readableChains(graph, result.reasons) }, null, 2) : formatAffected(graph, result, values.verbose));
  return values['exit-code'] && result.affected ? 1 : 0;
};

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  // Messages can quote repository content (a JSON parse error shows the bad text).
  console.error(`byakugan: ${safe(String((error as Error).message ?? error).replace(/[\r\n]+/g, ' '))}`);
  process.exitCode = 2;
}
