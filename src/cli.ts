import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compareBuilds } from './compare.ts';
import { affectedSinceCommit, affectedSinceManifest, createManifest, readManifest } from './affected.ts';
import { UsageGraph, type ModuleCache } from './graph.ts';
import { isConfigEntry, loadProject } from './project.ts';
import { describeNode, formatAffected, formatDot, formatGraph, formatMermaid, formatWhy, safe, summarize, why } from './report.ts';
import { eachFingerprints, eachProject, eachSinceManifest, entriesReaching } from './select.ts';
import { doctorOk, doctorReport, formatDoctor, type DoctorReport } from './doctor.ts';
import { COMMAND_NAMES, COMMANDS, OPTIONS, commandHelp, findCommand, mainHelp, type OptionName } from './help.ts';
import { closest, colorEnabled, createStyle } from './ui.ts';
import { toolVersion } from './version.ts';
import { workspaceApps } from './workspace.ts';

/** A mistake in how byakugan was called, or a setup problem with a known fix. Exits with 2. */
class UsageError extends Error {
  hint?: string;
  /** The command whose --help covers this. */
  command?: string;
  constructor(message: string, hint?: string, command?: string) {
    super(message);
    this.hint = hint;
    this.command = command;
  }
}

const out = createStyle(colorEnabled(process.stdout));
const err = createStyle(colorEnabled(process.stderr));

/** A line on stderr that the next one overwrites. Only on a terminal, so logs stay clean. */
const progress = (text: string) => {
  if (!process.stderr.isTTY || !err.on) return;
  process.stderr.write(text ? `\r\u001b[2K${err.dim(safe(text))}` : '\r\u001b[2K');
};

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
  cwd?: string;
}

const messageOf = (error: unknown) => String((error as Error).message ?? error);

/** `--workspace`: one result per app. An app that fails to build a graph counts as affected. */
const workspaceMain = (command: string, root: string, values: Values): number => {
  const apps = workspaceApps(root, values.strict ? { mode: 'strict' } : undefined);
  if (apps.length === 0) {
    throw new UsageError(
      `No apps found in the workspace at ${root}`,
      'A package is an app when byakugan detects a framework in it, or when it has a byakugan.json with "entry" globs. Add one to each package you want a verdict for.',
      command
    );
  }
  // Apps share packages, so each file is parsed once for the whole run.
  const cache: ModuleCache = new Map();
  if (command === 'doctor') {
    const reports: DoctorReport[] = [];
    apps.forEach(({ path, project, error }, i) => {
      progress(`byakugan: ${path} (${i + 1} of ${apps.length})`);
      try {
        if (!project) throw new Error(error);
        reports.push(doctorReport(path, new UsageGraph(project, undefined, cache).build()));
      } catch (e) {
        reports.push({ app: path, framework: '', entries: 0, projectFiles: 0, packageFiles: 0, fingerprint: '', error: messageOf(e), findings: [] });
      }
    });
    progress('');
    const ok = doctorOk(reports);
    console.log(values.json ? JSON.stringify({ ok, apps: reports }, null, 2) : formatDoctor(reports, out, { verbose: values.verbose, workspace: true, cwd: values.cwd }));
    return ok ? 0 : 1;
  }
  const results: Array<{ app: string; affected: boolean; fingerprint: string; reason: string; error?: string; warnings: string[] }> = [];
  apps.forEach(({ path, project, error }, i) => {
    progress(`byakugan: ${path} (${i + 1} of ${apps.length})`);
    try {
      if (!project) throw new Error(error);
      const graph = new UsageGraph(project, undefined, cache).build();
      if (command === 'hash') {
        if (values.manifest) {
          mkdirSync(values.manifest, { recursive: true });
          writeFileSync(manifestFile(values.manifest, path), `${JSON.stringify(createManifest(graph), null, 2)}\n`);
        }
        results.push({ app: path, affected: true, fingerprint: graph.fingerprint(), reason: '', warnings: graph.warnings });
        return;
      }
      const result = values['base-manifest']
        ? affectedSinceManifest(graph, readManifest(manifestFile(values['base-manifest'], path)))
        : affectedSinceCommit(graph, values.base as string);
      results.push({ app: path, affected: result.affected, fingerprint: result.fingerprint, reason: firstReason(result), warnings: result.warnings });
      if (values.verbose && !values.json) {
        progress('');
        console.log(`${out.paint(['bold', 'cyan'], safe(path))}\n${formatAffected(graph, result, true, out)}\n`);
      }
    } catch (e) {
      const message = messageOf(e);
      results.push({ app: path, affected: true, fingerprint: '', reason: `error: ${message}`, error: message, warnings: [] });
    }
  });
  progress('');
  const fingerprints = Object.fromEntries(results.map(r => [r.app, r.fingerprint]));
  const width = Math.max(...results.map(r => r.app.length)) + 2;
  if (command === 'hash') {
    githubOutput({ fingerprints: JSON.stringify(fingerprints) });
    if (values.json) console.log(JSON.stringify({ apps: results.map(r => ({ app: r.app, fingerprint: r.fingerprint, error: r.error, warnings: r.warnings })) }, null, 2));
    else {
      for (const r of results) warn(r.warnings.map(w => `${r.app}: ${w}`));
      for (const r of results) console.log(`${safe(r.app.padEnd(width))}${r.fingerprint || out.red(safe(r.reason))}`);
    }
    return results.some(r => r.error) ? 2 : 0;
  }
  const affectedApps = results.filter(r => r.affected).map(r => r.app);
  githubOutput({ affected: String(affectedApps.length > 0), apps: JSON.stringify(affectedApps), fingerprints: JSON.stringify(fingerprints) });
  stepSummary(results.map(r => ({ app: r.app, affected: r.affected, reason: r.reason })));
  if (values.json) console.log(JSON.stringify({ affected: affectedApps, apps: results }, null, 2));
  else {
    if (!values.verbose) {
      for (const r of results) {
        const status = (r.affected ? 'affected' : 'unaffected').padEnd(12);
        const painted = r.error ? out.red(status) : r.affected ? out.yellow(status) : out.green(status);
        console.log(`${safe(r.app.padEnd(width))}${painted}${out.dim(safe(r.reason.replace(/[\r\n]+/g, ' ')))}`.trimEnd());
      }
    }
    const warned = results.filter(r => r.warnings.length > 0).length;
    console.error(
      err.dim(`byakugan: ${affectedApps.length} of ${results.length} apps affected${warned > 0 ? `, ${warned} with warnings (see "byakugan doctor --workspace")` : ''}`)
    );
  }
  return values['exit-code'] && affectedApps.length > 0 ? 1 : 0;
};

/** Warnings go to stderr, so stdout stays a fingerprint or JSON that scripts can read. */
const warn = (warnings: string[]) => {
  for (const w of warnings) console.error(`byakugan: ${err.yellow('warning:')} ${safe(w.replace(/[\r\n]/g, ' '))}`);
};

const PARSE_OPTIONS = {
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
} as const;

const FLAGS = Object.keys(PARSE_OPTIONS).map(name => `--${name}`);

/** The first argument that is not an option or an option's value: the command, when one was given. */
const commandIn = (argv: string[]): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) return arg;
    const name = arg === '-C' ? 'cwd' : arg.replace(/^--/, '');
    if (!arg.includes('=') && (PARSE_OPTIONS as Record<string, { type: string }>)[name]?.type === 'string') i++;
  }
  return undefined;
};

const parse = (argv: string[]) => {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: PARSE_OPTIONS });
  } catch (error) {
    const command = findCommand(commandIn(argv) ?? '')?.name;
    const code = (error as { code?: string }).code;
    const unknown = /Unknown option '([^']+)'/.exec(messageOf(error))?.[1];
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && unknown) {
      const flag = unknown.split('=')[0];
      const near = closest(flag, FLAGS);
      throw new UsageError(`Unknown option ${flag}`, near ? `Did you mean ${near}?` : undefined, command ?? '');
    }
    const missing = /Option '(?:-\w, )?(--[\w-]+)[^']*' argument missing/.exec(messageOf(error))?.[1];
    if (missing) {
      const name = missing.slice(2) as OptionName;
      throw new UsageError(`${missing} needs a value`, OPTIONS[name] ? `${OPTIONS[name].flag}: ${OPTIONS[name].text}` : undefined, command ?? '');
    }
    throw new UsageError(messageOf(error), undefined, command ?? '');
  }
};

/** Hints for failures deeper in the tool, matched by their message. */
const hintFor = (message: string, values: Values): string | undefined => {
  if (/is not inside a git repository/.test(message)) return 'affected --base reads the base side from git. Without git, save a manifest with "byakugan hash --manifest <file>" and compare with --base-manifest.';
  if (/is not a byakugan manifest/.test(message)) return 'Write a manifest with: byakugan hash --manifest <file>';
  if (/ENOENT/.test(message) && values['base-manifest']) return 'No manifest at that path. Save one on the base commit with "byakugan hash --manifest <file>". In CI, fall back to --base <ref> when the cache has none.';
  if (/ENOENT|ENOTDIR/.test(message) && values.cwd) return `Check the directory passed to -C (${values.cwd}).`;
  if (/is not valid JSON|must be a list of strings|must be one of|must hold a JSON object|must be a string|must be an object/.test(message)) return 'docs/configuration.md lists every byakugan.json field. "byakugan guide" shows common setups.';
  if (/is not a commit in this clone/.test(message)) return 'Fetch the base first (git fetch origin main) and name it as origin/main. In GitHub Actions set fetch-depth: 0 on actions/checkout.';
  return undefined;
};

const guideText = (): string => {
  try {
    return readFileSync(new URL('../docs/adopting.md', import.meta.url), 'utf8');
  } catch {
    return 'The guide is at https://github.com/IShotTheSheriff/byakugan/blob/main/docs/adopting.md\n';
  }
};

const main = (argv: string[]): number => {
  const { values, positionals } = parse(argv);

  if (values.version) {
    console.log(version());
    return 0;
  }
  // `byakugan help affected`, `byakugan affected --help` and `byakugan --help`.
  if (values.help || positionals[0] === 'help') {
    const name = positionals[0] === 'help' ? positionals[1] : positionals[0];
    const found = name ? findCommand(name) : undefined;
    if (name && !found) {
      const near = closest(name, COMMAND_NAMES);
      throw new UsageError(`Unknown command "${name}"`, near ? `Did you mean "${near}"?` : `Commands: ${COMMAND_NAMES.join(', ')}`, '');
    }
    console.log(found ? commandHelp(found, out) : mainHelp(out, version()));
    return 0;
  }

  const [command = 'graph', target] = positionals;
  const spec = findCommand(command);
  if (!spec) {
    const near = closest(command, COMMAND_NAMES);
    throw new UsageError(`Unknown command "${command}"`, near ? `Did you mean "${near}"?` : `Commands: ${COMMAND_NAMES.join(', ')}`, '');
  }
  for (const name of Object.keys(values) as OptionName[]) {
    if (spec.options.includes(name)) continue;
    const users = COMMANDS.filter(c => c.options.includes(name)).map(c => c.name);
    throw new UsageError(`--${name} does not work with ${command}`, `It works with: ${users.join(', ')}`, command);
  }

  if (command === 'guide') {
    process.stdout.write(guideText());
    return 0;
  }
  if (command === 'compare') {
    const [, base, fresh] = positionals;
    if (!base || !fresh) throw new UsageError('compare needs two build directories', 'byakugan compare <base build dir> <fresh build dir>', command);
    const differences = compareBuilds(base, fresh, { maps: values.maps });
    if (values.json) console.log(JSON.stringify({ same: differences.length === 0, differences }, null, 2));
    else if (differences.length === 0) console.log(out.green(`${out.on ? '✔ ' : ''}The builds match.`));
    else console.log(safe(`The builds differ in ${differences.length} file${differences.length === 1 ? '' : 's'}:\n\n${differences.map(d => `${d.path}: ${d.detail}`).join('\n\n')}`));
    return differences.length === 0 ? 0 : 1;
  }
  if (command === 'why' && !target) {
    throw new UsageError('why needs a target', 'A file (src/lib/utils.ts), an export (src/lib/utils.ts#formatDate), a package (lodash) or a package file (npm:lodash/partition.js)', command);
  }
  if (command === 'affected' && !values.base === !values['base-manifest']) {
    throw new UsageError(
      values.base ? 'affected takes --base or --base-manifest, not both' : 'affected needs exactly one of --base <ref> or --base-manifest <file>',
      'Use --base origin/main to compare with git, or --base-manifest <file> to compare with a manifest that "byakugan hash --manifest" saved.',
      command
    );
  }
  if (values.each && values.workspace) throw new UsageError('--each does not work with --workspace', 'Run it once per app: byakugan affected -C <app> --each <glob> --base <ref>', command);
  if (values.workspace) return workspaceMain(command, realpathSync(resolve(values.cwd ?? process.cwd())), values);

  const loaded = loadProject({ cwd: values.cwd, config: values.strict ? { mode: 'strict' } : undefined });
  const selection = values.each ? eachProject(loaded, values.each) : undefined;
  const project = selection?.project ?? loaded;
  if (selection && selection.each.length === 0) {
    throw new UsageError(`No files in ${loaded.dir} match ${values.each?.join(', ') ?? ''}`, '--each globs are relative to the app directory (-C). Quote them, so the shell does not expand them.', command);
  }
  if (command === 'doctor') {
    const graph = new UsageGraph(project).build();
    const report = doctorReport(graph.fileKey(project.dir) || '.', graph);
    const ok = doctorOk([report]);
    console.log(values.json ? JSON.stringify({ ok, apps: [report] }, null, 2) : formatDoctor([report], out, { verbose: values.verbose, cwd: values.cwd }));
    return ok ? 0 : 1;
  }
  // Only config files (vite.config.ts, next.config.js) means the app's own entries were not found:
  // a fingerprint of the config alone would miss every source change.
  if (project.entries.every(isConfigEntry)) {
    throw new UsageError(
      `No entry files found in ${project.dir}. Add "entry" globs to byakugan.json.`,
      'byakugan found no framework routes and no index, main, server or app file. Put { "entry": ["src/main.ts"] } in byakugan.json next to package.json, or pass -C <app dir>. In a monorepo, "byakugan doctor --workspace" lists the apps.',
      command
    );
  }
  const graph = new UsageGraph(project).build();

  if (command === 'graph') {
    if (values.mermaid) console.log(formatMermaid(graph));
    else if (values.dot) console.log(formatDot(graph));
    else if (values.json) console.log(JSON.stringify(summarize(graph), null, 2));
    else console.log(formatGraph(summarize(graph), out));
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
      console.log(formatWhy(graph, result, out));
    }
    return 0;
  }

  const baseManifest = values['base-manifest'] ? readManifest(values['base-manifest']) : undefined;
  if (selection && baseManifest && !baseManifest.each) {
    throw new UsageError(`${values['base-manifest'] ?? ''} has no per-file fingerprints`, 'Write it with the same globs: byakugan hash --each <glob> --manifest <file>', command);
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
  console.log(values.json ? JSON.stringify({ ...result, reasons: readableChains(graph, result.reasons) }, null, 2) : formatAffected(graph, result, values.verbose, out));
  return values['exit-code'] && result.affected ? 1 : 0;
};

const argv = process.argv.slice(2);
try {
  process.exitCode = main(argv);
} catch (error) {
  progress('');
  // Messages can quote repository content (a JSON parse error shows the bad text).
  const message = safe(messageOf(error).replace(/[\r\n]+/g, ' '));
  const usage = error instanceof UsageError ? error : undefined;
  const cwdAt = argv.findIndex(a => a === '-C' || a === '--cwd');
  const hint = usage?.hint ?? hintFor(message, { cwd: cwdAt === -1 ? undefined : argv[cwdAt + 1], 'base-manifest': argv.some(a => a.startsWith('--base-manifest')) ? 'set' : undefined });
  const help = usage?.command === undefined ? undefined : usage.command ? `byakugan ${usage.command} --help` : 'byakugan --help';
  if (argv.includes('--json')) {
    console.error(JSON.stringify({ error: { message, hint: hint && safe(hint), help } }));
  } else {
    console.error(`byakugan: ${err.paint(['bold', 'red'], 'error:')} ${message}`);
    if (hint) console.error(`  ${err.cyan('hint:')} ${safe(hint)}`);
    if (help) console.error(`  ${err.cyan('help:')} ${help}`);
  }
  process.exitCode = 2;
}
