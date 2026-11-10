import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageGraph } from './graph.ts';
import { isConfigEntry } from './project.ts';
import { safe, summarize } from './report.ts';
import { wrap, type Paint, type Style } from './ui.ts';

/**
 * What a problem costs. `blocks`: every run reports "affected", so verdicts say nothing.
 * `hides`: a change can go unseen. `coarse`: extra runs, never a missed change. `note`: worth knowing.
 */
export type Severity = 'blocks' | 'hides' | 'coarse' | 'note';

export interface Finding {
  severity: Severity;
  kind: string;
  title: string;
  count: number;
  cost: string;
  fix: string;
  examples: string[];
}

export interface DoctorReport {
  /** App directory relative to the workspace root, `.` for the root itself. */
  app: string;
  framework: string;
  entries: number;
  projectFiles: number;
  packageFiles: number;
  fingerprint: string;
  /** The graph could not be built, for example over an invalid `byakugan.json`. */
  error?: string;
  findings: Finding[];
}

interface Rule {
  kind: string;
  test: RegExp;
  severity: Severity;
  title: (n: number) => string;
  cost: string;
  fix: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Graph warnings, grouped by their text. A new warning in graph.ts lands in `other` until it gets a rule here. */
const RULES: Rule[] = [
  {
    kind: 'unresolved-import',
    test: /cannot resolve "/,
    severity: 'blocks',
    title: n => `${plural(n, 'import')} of project code cannot be resolved`,
    cost: 'Every run reports "affected", because such an import could hide any change.',
    fix: 'byakugan reads tsconfig "paths", not webpack, Turbopack or Vite aliases. Declare the alias in tsconfig "paths". For a module that a bundler plugin provides, list its specifier under "virtual" in byakugan.json.',
  },
  {
    kind: 'build-output',
    test: /resolves to build output/,
    severity: 'hides',
    title: n => `${plural(n, 'workspace package resolves', 'workspace packages resolve')} to build output`,
    cost: 'The app imports dist files that git does not track, so git mode misses source changes in that package.',
    fix: 'Add a "source" condition to the package\'s "exports" that points at its source, and set "conditions": ["source"] in the app\'s byakugan.json.',
  },
  {
    kind: 'computed-import',
    test: /cannot follow/,
    severity: 'hides',
    title: n => `${plural(n, 'computed import')} cannot be followed`,
    cost: 'byakugan cannot tell which files such an import loads, so a change to one of them goes unseen.',
    fix: 'List the files it can load under "entry" (code) or "inputs" (data) in byakugan.json.',
  },
  {
    kind: 'outside-repository',
    test: /outside the repository/,
    severity: 'hides',
    title: n => `${plural(n, 'path points', 'paths point')} outside the repository`,
    cost: 'byakugan reads nothing outside the git root, so those files never count.',
    fix: 'Move the files into the repository, or add what they depend on to your own cache key.',
  },
  {
    kind: 'unreadable-file',
    test: /cannot read it/,
    severity: 'hides',
    title: n => `${plural(n, 'file')} cannot be read`,
    cost: 'A missing file or a link to something that is not a regular file is left out of the graph.',
    fix: 'Install dependencies and run code generation before byakugan, as the build does.',
  },
  {
    kind: 'tailwind-failed',
    test: /could not run Tailwind/,
    severity: 'coarse',
    title: n => `Tailwind could not run for ${plural(n, 'stylesheet')}`,
    cost: 'Every file Tailwind may scan is hashed whole, so edits to unused files count.',
    fix: 'Run byakugan after the install step, and check that the Tailwind config loads without the build environment.',
  },
  {
    kind: 'whole-directory',
    test: /reads files from the whole project directory/,
    severity: 'hides',
    title: n => `${plural(n, 'file reads', 'files read')} from the whole project directory`,
    cost: 'byakugan does not hash the whole project for such a read, so the files that code reads do not count.',
    fix: 'List the files the code reads under "inputs" in byakugan.json.',
  },
  {
    kind: 'missing-export',
    test: /no export named "/,
    severity: 'coarse',
    title: n => `${plural(n, 'import names', 'imports name')} an export byakugan cannot find`,
    cost: 'Every export of the target file counts as used.',
    fix: 'Usually harmless. Check that the import is not a typo.',
  },
];

/** The part of a warning that names the place, without the explanation the finding already gives. */
const example = (warning: string) => warning.split(/, so |; list |\. Point | \(a bundler alias/)[0];

export const diagnose = (graph: UsageGraph): Finding[] => {
  const findings: Finding[] = [];
  const project = graph.project;
  const groups = new Map<Rule | undefined, string[]>();
  for (const warning of graph.warnings) {
    const rule = RULES.find(r => r.test.test(warning));
    const list = groups.get(rule);
    if (list) list.push(warning);
    else groups.set(rule, [warning]);
  }
  for (const rule of RULES) {
    const warnings = groups.get(rule);
    if (!warnings) continue;
    findings.push({ severity: rule.severity, kind: rule.kind, title: rule.title(warnings.length), count: warnings.length, cost: rule.cost, fix: rule.fix, examples: warnings.map(example) });
  }
  const other = groups.get(undefined);
  if (other) {
    findings.push({
      severity: 'note',
      kind: 'other',
      title: plural(other.length, 'other warning'),
      count: other.length,
      cost: 'Read each one. It names something byakugan handled with a guess.',
      fix: 'See docs/limits.md for what each warning means.',
      examples: other,
    });
  }
  if (project.entries.length === 0 || project.entries.every(isConfigEntry)) {
    findings.unshift({
      severity: 'blocks',
      kind: 'no-entries',
      title: 'no entry files found',
      count: 1,
      cost: 'Without entries there is no app code to follow, so commands stop with an error.',
      fix: 'Add "entry" globs to byakugan.json next to the app\'s package.json, e.g. { "entry": ["src/main.ts"] }.',
      examples: [],
    });
  }
  const summary = summarize(graph);
  const uncounted = summary.env.read.filter(name => !summary.env.counted.includes(name));
  if (uncounted.length > 0) {
    findings.push({
      severity: 'note',
      kind: 'env',
      title: `${plural(uncounted.length, 'environment variable')} read by live code, values not counted`,
      count: uncounted.length,
      cost: 'A changed value does not change the fingerprint. That is right for runtime settings and wrong for values the build inlines.',
      fix: 'List the names whose values change the build under "env" in byakugan.json, e.g. { "env": ["API_*"] }.',
      examples: uncounted,
    });
  }
  if (!project.repo) {
    findings.push({
      severity: 'note',
      kind: 'no-git',
      title: 'not a git repository',
      count: 1,
      cost: 'affected --base needs git. hash and affected --base-manifest work without it.',
      fix: 'Run byakugan in a clone, or compare manifests.',
      examples: [],
    });
  } else if (existsSync(join(project.repo, '.git', 'shallow'))) {
    findings.push({
      severity: 'note',
      kind: 'shallow-clone',
      title: 'this clone is shallow',
      count: 1,
      cost: 'affected --base needs the merge base. Without it, changes on the base branch count as yours.',
      fix: 'Fetch full history. In GitHub Actions set fetch-depth: 0 on actions/checkout.',
      examples: [],
    });
  }
  return findings;
};

export const doctorReport = (app: string, graph: UsageGraph): DoctorReport => {
  const summary = summarize(graph);
  return {
    app,
    framework: summary.framework,
    entries: summary.entries.length,
    projectFiles: summary.stats.projectFiles,
    packageFiles: summary.stats.packageFiles,
    fingerprint: summary.fingerprint,
    findings: diagnose(graph),
  };
};

/** A doctor run fails when a problem makes verdicts useless or can hide a change. */
export const doctorOk = (reports: DoctorReport[]): boolean =>
  reports.every(r => !r.error && r.findings.every(f => f.severity !== 'blocks' && f.severity !== 'hides'));

const PAINT: Record<Severity, Paint> = { blocks: 'red', hides: 'yellow', coarse: 'blue', note: 'dim' };
const count = (report: DoctorReport, severity: Severity) => report.findings.filter(f => f.severity === severity).reduce((n, f) => n + f.count, 0);

const findingLines = (finding: Finding, style: Style, verbose: boolean): string[] => {
  const pad = ' '.repeat(8);
  const fix = wrap(`fix ${finding.fix}`, pad).map((line, i) => (i === 0 ? line.replace('fix', style.cyan('fix')) : line));
  const out = [`${style.paint(['bold', PAINT[finding.severity]], finding.severity.padEnd(8))}${style.bold(safe(finding.title))}`, ...wrap(finding.cost, pad), ...fix];
  const shown = verbose ? finding.examples : finding.examples.slice(0, 3);
  for (const e of shown) out.push(style.dim(`${pad}- ${safe(e.replace(/[\r\n]+/g, ' '))}`));
  if (shown.length < finding.examples.length) out.push(style.dim(`${pad}… ${finding.examples.length - shown.length} more (use --verbose)`));
  return out;
};

const appLines = (report: DoctorReport, style: Style, verbose: boolean): string[] => {
  const out: string[] = [];
  if (report.error) return [`${style.paint(['bold', 'red'], 'error'.padEnd(8))}${safe(report.error)}`];
  if (report.findings.length === 0) return [style.green(`${style.on ? '✔ ' : ''}no problems found`)];
  for (const finding of report.findings) {
    if (out.length > 0) out.push('');
    out.push(...findingLines(finding, style, verbose));
  }
  return out;
};

export const formatDoctor = (reports: DoctorReport[], style: Style, options: { verbose?: boolean; workspace?: boolean; cwd?: string } = {}): string => {
  const out: string[] = [];
  const flag = options.cwd ? ` -C ${options.cwd}` : '';
  if (!options.workspace) {
    const [report] = reports;
    out.push(`${style.bold('byakugan doctor')} · ${safe(report.app)} · ${report.framework}`);
    out.push(`${plural(report.entries, 'entry', 'entries')} · ${plural(report.projectFiles, 'project file')} · ${plural(report.packageFiles, 'package file')}`, '');
    out.push(...appLines(report, style, options.verbose === true));
  } else {
    out.push(`${style.bold('byakugan doctor')} · ${plural(reports.length, 'app')}`, '');
    const rows = [
      ['app', 'framework', 'entries', 'files', 'blocks', 'hides', 'coarse'],
      ...reports.map(r => (r.error ? [r.app, 'error', '', '', '', '', ''] : [r.app, r.framework, String(r.entries), String(r.projectFiles), String(count(r, 'blocks')), String(count(r, 'hides')), String(count(r, 'coarse'))])),
    ];
    const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)) + 2);
    rows.forEach((row, i) => {
      const cells = row.map((cell, j) => {
        const text = safe(cell).padEnd(widths[j]);
        if (i === 0) return style.dim(text);
        if (j === 4 && cell !== '0' && cell !== '') return style.red(text);
        if (j === 5 && cell !== '0' && cell !== '') return style.yellow(text);
        if (j === 1 && cell === 'error') return style.red(text);
        return text;
      });
      out.push(cells.join('').trimEnd());
    });
    for (const report of reports) {
      const serious = report.error !== undefined || report.findings.some(f => f.severity === 'blocks' || f.severity === 'hides');
      if (!serious && !(options.verbose && report.findings.length > 0)) continue;
      const shown = options.verbose ? report : { ...report, findings: report.findings.filter(f => f.severity === 'blocks' || f.severity === 'hides') };
      out.push('', style.paint(['bold', 'cyan'], safe(report.app)), ...appLines(shown, style, options.verbose === true));
    }
  }
  const used = new Set(reports.flatMap(r => r.findings.map(f => f.severity)));
  out.push('', style.bold('Next'));
  if (doctorOk(reports)) {
    out.push(
      options.workspace ? `  byakugan affected --workspace --base origin/main${flag}` : `  byakugan affected --base origin/main${flag}`,
      style.dim('  Then run it next to real builds for a while before you skip anything. "byakugan guide" has the steps.')
    );
  } else {
    const errors = reports.some(r => r.error);
    const kinds = (['blocks', 'hides'] as Severity[]).filter(s => used.has(s)).map(s => `"${s}"`);
    const what = [errors ? 'the errors' : '', kinds.length > 0 ? `the ${kinds.join(' and ')} findings` : ''].filter(Boolean).join(' and ');
    out.push(`  Fix ${what} above, then run doctor again.`, style.dim('  "byakugan guide" explains each fix. byakugan.json sits next to the app\'s package.json.'));
  }
  return out.join('\n');
};
