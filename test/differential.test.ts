import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { affected, analyze } from '../src/index.ts';
import { app, git } from './helpers.ts';

/**
 * Git mode works out the base side from a diff, with one special case per kind of change. The
 * fingerprint needs none: it hashes the graph. So for any edit, a fingerprint that moved must come
 * with "affected". This test applies seeded random edits to a small project that uses most import
 * forms and checks that. A failure prints its seed; rerun one with BYAKUGAN_SEEDS=330-330.
 */
const FILES: Record<string, string | object> = {
  'package.json': { name: 'app', private: true, type: 'module' },
  'byakugan.json': { entry: ['src/main.ts'] },
  'tsconfig.json': { compilerOptions: { jsx: 'react-jsx', paths: { '@/*': ['./src/*', './alt/*'] } } },
  '.gitignore': 'node_modules/\n',
  'node_modules/react/package.json': { name: 'react', version: '19.0.0' },
  'node_modules/react/jsx-runtime.js': 'exports.jsx = function () {};\n',
  'node_modules/react/jsx-dev-runtime.js': 'exports.jsx = function () {};\n',
  'node_modules/pure/package.json': { name: 'pure', version: '1.0.0', sideEffects: false, type: 'module', main: 'index.js' },
  'node_modules/pure/index.js': 'export const one = 1;\nexport const two = 2;\n',
  'src/main.ts': [
    "import './setup';",
    "import { price, Shape } from './barrel';",
    "import * as math from './math';",
    "import type { Options } from './types';",
    "import run, { helper as h } from './run';",
    "import { View } from './view';",
    "import { aliased } from '@/aliased';",
    "import data from './data.json' with { type: 'json' };",
    "import { one } from 'pure';",
    "import { deep } from './dir';",
    "const options: Options = { depth: 1 };",
    "export const lazy = () => import('./lazy');",
    "console.log(price(2), Shape.Round, math.add(1, 2), run(options), h(), View, aliased, data.a, one, deep);",
  ].join('\n') + '\n',
  'src/setup.ts': ["import './setup-more';", "const mark = 'ready';", '(globalThis as any).mark = mark;'].join('\n') + '\n',
  'src/setup-more.ts': ['(globalThis as any).more = 1;'].join('\n') + '\n',
  'src/barrel.ts': ["export * from './price';", "export * from './shape';", "export { unusedThing } from './unused';", "export * as extra from './extra';"].join('\n') + '\n',
  'src/price.ts': ["import { rate } from './rate';", 'const base = 10;', 'export const price = (n: number) => n * base * rate;', 'export const discount = (n: number) => n - 1;', 'export default 5;'].join('\n') + '\n',
  'src/rate.ts': ['export const rate = 2;', 'export const oldRate = 3;'].join('\n') + '\n',
  'src/shape.ts': ['export enum Shape { Round = 1, Square = 2 }', 'export const sides = 4;', "console.log('shape');"].join('\n') + '\n',
  'src/unused.ts': ['export const unusedThing = 1;', "export const alsoUnused = 'x';"].join('\n') + '\n',
  'src/extra.ts': ['export const e1 = 1;', 'export const e2 = 2;'].join('\n') + '\n',
  'src/math.ts': ['const k = 1;', 'export const add = (a: number, b: number) => a + b + k - k;', 'export const sub = (a: number, b: number) => a - b;', 'export function mul(a: number, b: number) { return a * b; }'].join('\n') + '\n',
  'src/types.ts': ["import type { Depth } from './depth';", 'export interface Options { depth: Depth }', 'export type Other = string;', 'export const runtimeValue = 1;'].join('\n') + '\n',
  'src/depth.ts': ['export type Depth = number;', 'export type Width = number;', "console.log('depth');"].join('\n') + '\n',
  'src/run.ts': ["import type { Options } from './types';", "import { log } from './log';", 'export const helper = () => 1;', 'export const spare = () => 2;', 'export default function run(o: Options) { return log(o.depth); }'].join('\n') + '\n',
  'src/log.ts': ['let count = 0;', 'export const log = (n: number) => { count += n; return count; };', 'export const reset = () => { count = 0; };', 'export class Logger { static level = 1; write() { return count; } }'].join('\n') + '\n',
  'src/view.tsx': ["import './view.css';", "import { Label } from './label';", 'export const View = () => <Label text="a" />;', 'export const Hidden = () => <i>hidden</i>;'].join('\n') + '\n',
  'src/view.css': '.view { color: red; }\n',
  'src/label.tsx': ['export const Label = (p: { text: string }) => <b>{p.text}</b>;', "Label.displayName = 'Label';", 'export const Badge = () => <u>badge</u>;', "Badge.displayName = 'Badge';"].join('\n') + '\n',
  'src/aliased.ts': ['export const aliased = 1;', 'export const aliasedSpare = 2;'].join('\n') + '\n',
  'alt/aliased.ts': ['export const aliased = 100;'].join('\n') + '\n',
  'src/data.json': '{ "a": 1, "b": 2 }\n',
  'src/dir/index.ts': ["export { deep } from './deep';", 'export const shallow = 1;'].join('\n') + '\n',
  'src/dir/deep.ts': ['export const deep = 1;', 'export const deeper = 2;'].join('\n') + '\n',
  'src/lazy.ts': ['export const lazyValue = 1;', "console.log('lazy');"].join('\n') + '\n',
  'src/orphan.ts': ["import './orphan-effect';", 'export const orphan = 1;'].join('\n') + '\n',
  'src/orphan-effect.ts': ["console.log('orphan');"].join('\n') + '\n',
};

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SOURCES = Object.keys(FILES).filter(f => /^(src|alt)\//.test(f));
const CODE = SOURCES.filter(f => /\.tsx?$/.test(f));

/** One random edit. Returns a description, or undefined when it did nothing. */
const mutate = (dir: string, random: () => number): string | undefined => {
  const pick = <T,>(list: T[]): T => list[Math.floor(random() * list.length)];
  const present = (list: string[]) => list.filter(f => existsSync(join(dir, f)));
  const code = present(CODE);
  if (code.length === 0) return;
  const file = pick(code);
  const path = join(dir, file);
  const lines = readFileSync(path, 'utf8').split('\n').filter(l => l !== '');
  const save = (next: string[]) => writeFileSync(path, next.join('\n') + '\n');
  const at = Math.floor(random() * lines.length);
  const stem = (f: string) => './' + f.replace(/^src\//, '').replace(/\.tsx?$/, '');
  switch (Math.floor(random() * 16)) {
    case 0: { // change a number or string
      const line = lines[at];
      const next = /\d+/.test(line) ? line.replace(/\d+(?!.*\d)/, d => String(Number(d) + 7)) : line.replace(/'([^']*)'(?!.*')/, "'$1z'");
      if (next === line) return;
      lines[at] = next; save(lines); return `${file}: edit line ${at}`;
    }
    case 1: lines.splice(at, 1); save(lines); return `${file}: delete line ${at}`;
    case 2: { if (!lines[at].startsWith('export ') || /^export (\*|\{|default)/.test(lines[at])) return; lines[at] = lines[at].replace(/^export /, ''); save(lines); return `${file}: unexport line ${at}`; }
    case 3: { const m = /^export (const|function|class|enum|interface|type) (\w+)/.exec(lines[at]); if (!m) return; lines[at] = lines[at].replace(m[2], m[2] + 'Renamed'); save(lines); return `${file}: rename ${m[2]}`; }
    case 4: { if (lines.length < 2) return; const b = Math.floor(random() * lines.length); if (b === at) return; [lines[at], lines[b]] = [lines[b], lines[at]]; save(lines); return `${file}: swap lines ${at} and ${b}`; }
    case 5: rmSync(path); return `${file}: delete file`;
    case 6: { const target = pick(present(CODE.filter(f => f.startsWith('src/') && f !== file && !f.includes('/dir/')))); if (!target || file.includes('/dir/') || file.startsWith('alt/')) return; lines.splice(at, 0, `import '${stem(target)}';`); save(lines); return `${file}: add import of ${target}`; }
    case 7: { lines.splice(at, 0, `export const added${Math.floor(random() * 1000)} = ${Math.floor(random() * 10)};`); save(lines); return `${file}: add an export`; }
    case 8: { const next = file.replace(/\.tsx?$/, '') + '/index.ts'; if (file.endsWith('index.ts') || existsSync(join(dir, next))) return; mkdirSync(dirname(join(dir, next)), { recursive: true }); writeFileSync(join(dir, next), `export const fromIndex = 1;\n`); return `${next}: add next to ${file}`; }
    case 9: { if (!file.endsWith('.ts') || file.endsWith('index.ts')) return; const next = file.replace(/\.ts$/, '.tsx'); if (existsSync(join(dir, next))) return; renameSync(path, join(dir, next)); return `${file}: rename to .tsx`; }
    case 10: { const line = lines[at]; const next = line.startsWith('import type ') ? line.replace('import type ', 'import ') : /^import \{/.test(line) ? line.replace('import ', 'import type ') : line; if (next === line) return; lines[at] = next; save(lines); return `${file}: toggle import type on line ${at}`; }
    case 11: { const m = /^export \* from ('.*');/.exec(lines[at]); if (!m) return; lines[at] = `import ${m[1]};`; save(lines); return `${file}: export * to bare import`; }
    case 12: { const m = /^import '(.*)';/.exec(lines[at]); if (!m) return; lines[at] = `export * from '${m[1]}';`; save(lines); return `${file}: bare import to export *`; }
    case 13: { lines.splice(at, 0, `console.log(${Math.floor(random() * 100)});`); save(lines); return `${file}: add a statement`; }
    case 14: { const other = pick(present(SOURCES.filter(f => !CODE.includes(f)))); if (!other) return; if (random() < 0.5) { rmSync(join(dir, other)); return `${other}: delete file`; } writeFileSync(join(dir, other), readFileSync(join(dir, other), 'utf8').replace(/[12]|red/, 'blue')); return `${other}: edit`; }
    case 15: { const m = /^export (const|function) (\w+)/.exec(lines[at]); if (!m) return; lines.push(`export { ${m[2]} as alias${at} };`); save(lines); return `${file}: alias ${m[2]}`; }
  }
};

describe('git mode against the fingerprint', () => {
  const [from, to] = (process.env.BYAKUGAN_SEEDS ?? '1-150').split('-').map(Number);

  test(`seeds ${from} to ${to}: a fingerprint that moved is reported as affected`, () => {
    const dir = app(FILES, { repo: true });
    const base = analyze({ cwd: dir }).fingerprint();
    const holes: string[] = [];
    let moved = 0;
    for (let seed = from; seed <= to; seed++) {
      git(dir, 'checkout', '-q', '.');
      git(dir, 'clean', '-qfd');
      const random = rng(seed);
      const edits: string[] = [];
      for (let i = 0, n = 1 + Math.floor(random() * 3); i < n; i++) {
        const edit = mutate(dir, random);
        if (edit) edits.push(edit);
      }
      if (edits.length === 0) continue;
      const result = affected({ cwd: dir, base: 'main' });
      if (result.fingerprint === base) continue;
      moved++;
      if (!result.affected) holes.push(`seed ${seed}: ${edits.join(' | ')}`);
    }
    assert.deepEqual(holes, []);
    // The edits must bite, or the test proves nothing.
    assert.ok(moved > (to - from + 1) / 4 || to - from < 20, `only ${moved} edits moved the fingerprint`);
  });
});
