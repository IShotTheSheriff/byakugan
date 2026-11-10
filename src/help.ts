import { wrap, type Style } from './ui.ts';

/** Every option of the CLI: how it is spelled in help, and what it does. */
export const OPTIONS = {
  cwd: { flag: '-C, --cwd <dir>', text: 'App directory, or the workspace root with --workspace (default: current directory)' },
  json: { flag: '--json', text: 'Print JSON on stdout. Errors become {"error":{"message","hint"}} on stderr' },
  mermaid: { flag: '--mermaid', text: 'Print the graph as a Mermaid diagram' },
  dot: { flag: '--dot', text: 'Print the graph as Graphviz DOT' },
  manifest: { flag: '--manifest <file>', text: 'Also save per-fragment hashes to <file>, for a later affected --base-manifest' },
  base: { flag: '--base <ref>', text: 'Compare with the merge base of <ref> and HEAD, e.g. origin/main' },
  'base-manifest': { flag: '--base-manifest <file>', text: 'Compare with a manifest that hash --manifest saved on the base commit' },
  'exit-code': { flag: '--exit-code', text: 'Exit with 1 when affected and 0 when not' },
  verbose: { flag: '--verbose', text: 'List every reason and every ignored change' },
  workspace: { flag: '--workspace', text: 'One result per app in the workspace at -C. --manifest and --base-manifest then name directories' },
  strict: { flag: '--strict', text: 'Promise the same build output, not only the same behavior. Same as "mode": "strict"' },
  each: { flag: '--each <glob>', text: 'One verdict per matching file (a test, a story) instead of one per app. Repeatable' },
  maps: { flag: '--maps', text: 'Compare source maps too' },
  help: { flag: '-h, --help', text: 'Show help for the command' },
  version: { flag: '-v, --version', text: 'Print the version' },
} as const;

export type OptionName = keyof typeof OPTIONS;

export interface Command {
  name: string;
  summary: string;
  usage: string[];
  /** One paragraph on what the command prints and when to use it. */
  about: string;
  options: OptionName[];
  examples: Array<[command: string, note: string]>;
  /** Exit codes other than 2, which always means a usage error or a failure. */
  exits: Array<[code: number, meaning: string]>;
  /** Top-level keys of the --json output. */
  json?: string;
}

export const COMMANDS: Command[] = [
  {
    name: 'doctor',
    summary: 'Check that byakugan reads this app correctly, and say what to fix',
    usage: ['byakugan doctor [-C <dir>] [--workspace] [--json]'],
    about:
      'Run this first. It builds the graph and lists every problem by what it costs: a problem that makes each run report "affected", one that can hide a change, and one that only costs extra runs. Each comes with the fix.',
    options: ['cwd', 'workspace', 'strict', 'verbose', 'json'],
    examples: [
      ['byakugan doctor -C apps/web', 'one app'],
      ['byakugan doctor --workspace', 'every app of the monorepo, as a table'],
      ['byakugan doctor --workspace --json', 'the same for a script or an agent'],
    ],
    exits: [
      [0, 'nothing blocks or hides a change'],
      [1, 'at least one problem makes verdicts useless or can hide a change'],
    ],
    json: '{ ok, apps: [{ app, framework, entries, projectFiles, packageFiles, fingerprint, error?, findings: [{ severity, kind, title, count, cost, fix, examples }] }] }',
  },
  {
    name: 'affected',
    summary: 'Do the changes since a base commit reach the app?',
    usage: [
      'byakugan affected --base <ref> [-C <dir>] [--each <glob>] [--exit-code]',
      'byakugan affected --base-manifest <file> [-C <dir>] [--each <glob>] [--exit-code]',
      'byakugan affected --workspace --base <ref>',
    ],
    about:
      'Prints "affected" with the import chain from an entry to each change, or "unaffected". --base reads the base side from git and counts dependency updates per package. --base-manifest compares two saved graphs and is exact for files inside node_modules too.',
    options: ['base', 'base-manifest', 'cwd', 'workspace', 'each', 'strict', 'exit-code', 'verbose', 'json'],
    examples: [
      ['byakugan affected --base origin/main -C apps/web', 'does this branch change apps/web?'],
      ['byakugan affected --workspace --base origin/main', 'one verdict per app'],
      ["byakugan affected --base origin/main --each 'src/**/*.test.ts'", 'the tests a change reaches, one per line'],
      ["byakugan affected --base origin/main --each 'src/**/*.stories.tsx'", 'the Storybook stories a change reaches'],
      ['byakugan affected --base-manifest .byakugan/web.json --exit-code', 'exact comparison, as an exit code'],
    ],
    exits: [
      [0, 'unaffected, or affected without --exit-code'],
      [1, 'affected, with --exit-code'],
    ],
    json: '{ affected, fingerprint, base?, reasons: [{ kind, key, detail, chain }], ignored: [{ path, fragments }], warnings }. With --each it adds { each: [files], all }. With --workspace it is { affected: [apps], apps: [{ app, affected, fingerprint, reason, error?, warnings }] }',
  },
  {
    name: 'hash',
    summary: 'Print a fingerprint of everything the app uses, for a cache key',
    usage: ['byakugan hash [-C <dir>] [--manifest <file>] [--each <glob>]', 'byakugan hash --workspace [--manifest <dir>]'],
    about:
      'Prints a SHA-256 over every used fragment, installed dependencies included. Equal fingerprints mean equal app inputs. Warnings go to stderr, so stdout holds only the fingerprint.',
    options: ['cwd', 'manifest', 'workspace', 'each', 'strict', 'json'],
    examples: [
      ['byakugan hash -C apps/web', 'a cache key for a test run'],
      ['byakugan hash -C apps/web --strict', 'a cache key for a build'],
      ['byakugan hash -C apps/web --manifest .byakugan/web.json', 'save a manifest on main'],
      ["byakugan hash --each 'src/**/*.test.ts' --manifest tests.json", 'one fingerprint per test file'],
    ],
    exits: [[0, 'the fingerprint was printed']],
    json: '{ fingerprint, fragments, warnings }. With --workspace it is { apps: [{ app, fingerprint, error?, warnings }] }',
  },
  {
    name: 'why',
    summary: 'Show the import chain that makes a file, export or package used',
    usage: ['byakugan why <target> [-C <dir>]'],
    about:
      'Prints the shortest chain from an entry to the target, or says nothing uses it. Use it to check a surprising verdict. A target is a file (src/lib/utils.ts), an export (src/lib/utils.ts#formatDate), a package (lodash) or a package file (npm:lodash/partition.js).',
    options: ['cwd', 'strict', 'json'],
    examples: [
      ['byakugan why packages/ui/src/Button.tsx#Button -C apps/web', 'why does web use Button?'],
      ['byakugan why lodash -C apps/web', 'which lodash files does web use, and through what?'],
    ],
    exits: [[0, 'used or not, the answer was printed']],
    json: '{ query, loaded, matches: [{ key, chain }], warnings }',
  },
  {
    name: 'graph',
    summary: 'List the files, exports and package files the app uses',
    usage: ['byakugan graph [-C <dir>] [--json | --mermaid | --dot]', 'byakugan [-C <dir>]'],
    about: 'Prints the entries byakugan found, each used project file with its used exports, the used files per package, and the inputs and environment variables that count.',
    options: ['cwd', 'strict', 'json', 'mermaid', 'dot'],
    examples: [
      ['byakugan graph -C apps/web', 'what does web use?'],
      ['byakugan graph -C apps/web --mermaid > web.mmd', 'the same as a diagram'],
    ],
    exits: [[0, 'the graph was printed']],
    json: '{ root, dir, framework, fingerprint, entries, inputs, files, packages, tracked, env, unresolved, warnings, stats }',
  },
  {
    name: 'compare',
    summary: 'Compare two build outputs without per-build noise',
    usage: ['byakugan compare <base build dir> <fresh build dir> [--maps]'],
    about:
      'Compares two build directories, such as two .next directories, and leaves out what differs between any two builds of the same code. This is how you check byakugan: when affected --strict says unaffected, a build of the change should match a build of the base.',
    options: ['maps', 'json'],
    examples: [['byakugan compare ../base/apps/web/.next apps/web/.next', 'did the build output change?']],
    exits: [
      [0, 'the builds match'],
      [1, 'the builds differ'],
    ],
    json: '{ same, differences: [{ path, detail }] }',
  },
  {
    name: 'guide',
    summary: 'Print the step-by-step guide for adding byakugan to a repository',
    usage: ['byakugan guide'],
    about: 'Prints docs/adopting.md from the installed package. It is written for a coding agent or a person who sets byakugan up in a monorepo: the commands to run in order, what each result means and which CI recipe fits.',
    options: [],
    examples: [['byakugan guide', 'read it before you write any CI configuration']],
    exits: [[0, 'the guide was printed']],
  },
];

export const COMMAND_NAMES = COMMANDS.map(c => c.name);

export const findCommand = (name: string): Command | undefined => COMMANDS.find(c => c.name === name);

const table = (rows: Array<[string, string]>, style: Style, indent = '  '): string[] => {
  const width = Math.max(...rows.map(r => r[0].length)) + 2;
  return rows.map(([left, right]) => `${indent}${style.cyan(left.padEnd(width))}${right}`);
};

const heading = (style: Style, text: string) => style.bold(text);

export const mainHelp = (style: Style, version: string): string =>
  [
    `${style.bold('byakugan')} ${style.dim(version)}  the graph of code your app uses, for CI that skips what a change cannot reach`,
    '',
    heading(style, 'Usage'),
    '  byakugan <command> [options]',
    '',
    heading(style, 'Commands'),
    ...table(COMMANDS.map(c => [c.name, c.summary]), style),
    '',
    heading(style, 'Start here'),
    ...table(
      [
        ['byakugan doctor --workspace', 'find the apps and what needs fixing'],
        ['byakugan affected --workspace --base origin/main', 'which apps does this branch change?'],
        ['byakugan why <file> -C apps/web', 'why is a file part of an app?'],
      ],
      style
    ),
    '',
    heading(style, 'More'),
    ...table(
      [
        ['byakugan <command> --help', 'options, examples, exit codes and JSON shape of a command'],
        ['byakugan guide', 'the step-by-step setup guide, for people and coding agents'],
      ],
      style
    ),
    '',
    style.dim('Exit codes: 0 done, 1 affected (with --exit-code) or a failed check, 2 usage error or failure.'),
    style.dim('Colors follow the terminal. NO_COLOR=1 turns them off, FORCE_COLOR=1 turns them on.'),
  ].join('\n');

export const commandHelp = (command: Command, style: Style): string => {
  const out = [`${style.bold(`byakugan ${command.name}`)}  ${command.summary}`, '', heading(style, 'Usage'), ...command.usage.map(u => `  ${u}`), '', ...wrap(command.about)];
  if (command.options.length > 0) {
    out.push('', heading(style, 'Options'), ...table(command.options.map(name => [OPTIONS[name].flag, OPTIONS[name].text]), style));
  }
  out.push('', heading(style, 'Examples'));
  for (const [example, note] of command.examples) out.push(`  ${style.dim(`# ${note}`)}`, `  ${example}`);
  out.push('', heading(style, 'Exit codes'), ...table([...command.exits.map(([code, meaning]): [string, string] => [String(code), meaning]), ['2', 'usage error or failure']], style));
  if (command.json) out.push('', heading(style, 'JSON'), ...wrap(command.json, '  '));
  if (command.name === 'affected' || command.name === 'hash') {
    out.push(
      '',
      heading(style, 'GitHub Actions'),
      '  Writes affected= and fingerprint= to $GITHUB_OUTPUT. With --each it writes each=, a JSON list of files.',
      '  With --workspace it writes apps=, a JSON list of affected app directories, and fingerprints=.'
    );
  }
  return out.join('\n');
};
