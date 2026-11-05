import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { affectedSinceCommit, affectedSinceManifest, createManifest, readManifest } from './affected.ts';
import { UsageGraph } from './graph.ts';
import { isConfigEntry, loadProject } from './project.ts';
import { formatAffected, formatDot, formatGraph, formatMermaid, formatWhy, safe, summarize, why } from './report.ts';

const HELP = `byakugan: the graph of code your app actually uses

Usage
  byakugan [graph]           Print used files, exports and package files (default)
  byakugan hash              Print a fingerprint of everything the app uses
  byakugan affected          Do changes since --base (or a saved manifest) reach the app?
  byakugan why <target>      Show the import chain that makes a file, export or package used

Options
  -C, --cwd <dir>            Project directory (default: current directory)
      --json                 JSON output
      --mermaid, --dot       Graph as Mermaid or Graphviz (graph)
      --manifest <file>      Also write per-fragment hashes to <file> (hash)
      --base <ref>           Compare with the merge base of <ref> and HEAD (affected)
      --base-manifest <file> Compare with a manifest from the base build (affected)
      --exit-code            Exit with 1 when affected, 0 when not (affected)
      --verbose              List every reason and ignored change (affected)
  -h, --help
  -v, --version

Targets for why: src/lib/utils.ts, src/lib/utils.ts#formatDate, lodash, npm:lodash/partition.js

In GitHub Actions, hash and affected also write fingerprint= and affected= to $GITHUB_OUTPUT.`;

const version = () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
};

const githubOutput = (values: Record<string, string>) => {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
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

  const project = loadProject({ cwd: values.cwd });
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
      writeFileSync(values.manifest, `${JSON.stringify(createManifest(graph), null, 2)}\n`);
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
    if (values.json) console.log(JSON.stringify({ ...result, warnings: graph.warnings }, null, 2));
    else {
      warn(graph.warnings);
      console.log(formatWhy(graph, result));
    }
    return 0;
  }

  const result = values['base-manifest']
    ? affectedSinceManifest(graph, readManifest(values['base-manifest']))
    : affectedSinceCommit(graph, values.base as string);
  githubOutput({ affected: String(result.affected), fingerprint: result.fingerprint });
  console.log(values.json ? JSON.stringify(result, null, 2) : formatAffected(graph, result, values.verbose));
  return values['exit-code'] && result.affected ? 1 : 0;
};

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  // Messages can quote repository content (a JSON parse error shows the bad text).
  console.error(`byakugan: ${safe(String((error as Error).message ?? error).replace(/[\r\n]+/g, ' '))}`);
  process.exitCode = 2;
}
