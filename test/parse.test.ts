import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseModule, type EsmModule } from '../src/parse.ts';

const esm = (source: string, file = 'x.tsx'): EsmModule => {
  const { module, errors } = parseModule(file, source);
  assert.deepEqual(errors, []);
  assert.equal(module.kind, 'esm');
  return module as EsmModule;
};

const refs = (m: EsmModule, name: string) => [...(m.decls.get(name)?.usage.refs ?? [])].sort();

describe('parseModule', () => {
  test('records references per declaration, not per file', () => {
    const m = esm(`
      import { a } from './a';
      const helper = () => a;
      export const used = () => helper();
      export const other = () => 1;
    `);
    assert.ok(refs(m, 'used').includes('helper'));
    assert.ok(!refs(m, 'used').includes('a'));
    assert.ok(refs(m, 'helper').includes('a'));
    assert.ok(!refs(m, 'other').includes('helper'));
  });

  test('skips property keys, member properties and labels', () => {
    const m = esm(`
      const x = 1;
      export const f = (o) => { loop: for (;;) { break loop; } return { x: o.x, [x]: 2 }; };
    `);
    const r = refs(m, 'f');
    assert.ok(r.includes('x'), 'computed key counts');
    assert.ok(!r.includes('loop'));
  });

  test('keeps namespace member access separate', () => {
    const m = esm(`
      import * as ns from './ns';
      export const f = () => ns.one() + <ns.Two />;
      export const g = () => Object.keys(ns);
    `);
    assert.deepEqual([...(m.decls.get('f')?.usage.members.get('ns') ?? [])].sort(), ['Two', 'one']);
    assert.ok(!refs(m, 'f').includes('ns'));
    assert.ok(refs(m, 'g').includes('ns'));
  });

  test('collects import(), require() and import types', () => {
    const m = esm(`
      export const Lazy = () => import('./Lazy');
      export const cfg = () => require('./config.json');
      export type T = import('./types').Foo;
      export const dyn = (p) => import(p);
    `);
    assert.deepEqual([...(m.decls.get('Lazy')?.usage.dynamic ?? [])], ['./Lazy']);
    assert.deepEqual([...(m.decls.get('cfg')?.usage.dynamic ?? [])], ['./config.json']);
    assert.deepEqual([...(m.decls.get('T')?.usage.types ?? [])], ['./types'], 'import types are types, not runtime imports');
    assert.deepEqual([...(m.decls.get('dyn')?.usage.dynamic ?? [])], []);
  });

  test('handles every export form', () => {
    const m = esm(`
      import def, { x as y, type T } from './a';
      export { y as z };
      export { q as r, default as s } from './b';
      export * from './c';
      export * as ns from './d';
      export type { U } from './e';
      export default function Page() {}
      export const [first, { second }] = list();
    `);
    assert.equal(m.imports.get('def')?.imported, 'default');
    assert.equal(m.imports.get('y')?.imported, 'x');
    assert.equal(m.imports.get('T')?.type, true);
    assert.deepEqual(m.exports.get('z'), { name: 'z', local: 'y', type: false, text: 'export y as z' });
    assert.equal(m.exports.get('r')?.imported, 'q');
    assert.equal(m.exports.get('s')?.imported, 'default');
    assert.equal(m.exports.get('ns')?.imported, '*');
    assert.equal(m.exports.get('U')?.type, true);
    assert.equal(m.exports.get('default')?.local, 'Page');
    assert.ok(m.decls.has('first') && m.decls.has('second'));
    assert.deepEqual(m.stars.map(s => s.source), ['./c']);
  });

  test('anonymous default exports and export = become a `default` declaration', () => {
    assert.ok(esm('export default () => 1;').decls.has('default'));
    assert.ok(esm('export default class extends Base {}').decls.get('default')?.usage.refs.has('Base'));
    const cjs = esm('const x = 1; export = x;', 'x.ts');
    assert.equal(cjs.exportEquals, true);
    assert.ok(cjs.decls.get('default')?.usage.refs.has('x'));
  });

  test('merges overloads and declaration merging into one declaration', () => {
    const m = esm(`
      export function over(a: string): void;
      export function over(a: number): void;
      export function over(a: any) { return impl(a); }
      export interface Box { a: A }
      export interface Box { b: B }
    `, 'x.ts');
    assert.ok(m.decls.get('over')?.usage.refs.has('impl'));
    assert.equal(m.decls.get('over')?.text.split('\n').length, 3);
    assert.ok(m.decls.get('Box')?.usage.refs.has('A') && m.decls.get('Box')?.usage.refs.has('B'));
  });

  test('member assignments attach to their declaration, other statements are side effects', () => {
    const m = esm(`
      'use client';
      import { register } from './registry';
      export function Button() {}
      Button.displayName = 'Button';
      window.foo = 1;
      register(Button);
      declare global { interface Window { foo: number } }
    `);
    assert.match(m.decls.get('Button')?.text ?? '', /displayName/);
    assert.match(m.effects.text, /'use client'/);
    assert.match(m.effects.text, /window\.foo/);
    assert.match(m.effects.text, /register\(Button\)/);
    assert.match(m.types.text, /declare global/, 'types only, it never runs');
    assert.ok(!m.effects.text.includes('declare global'));
    assert.ok(!m.effects.text.includes('displayName'));
    assert.ok(m.effects.usage.refs.has('register'));
  });

  test('qualified type names count as namespace members', () => {
    const m = esm(`import type * as API from './api'; export type R = API.Response<API.Error>;`, 'x.ts');
    assert.deepEqual([...(m.decls.get('R')?.usage.members.get('API') ?? [])].sort(), ['Error', 'Response']);
  });

  test('enum member names are not references', () => {
    const m = esm('const A = 1; export enum E { A = 2, B = A }', 'x.ts');
    assert.ok(m.decls.get('E')?.usage.refs.has('A'), 'initializer reference counts');
    assert.equal(esm('const A = 1; export enum E { A }', 'x.ts').decls.get('E')?.usage.refs.has('A'), false);
  });

  test('CommonJS files are opaque and list their requires', () => {
    const { module } = parseModule('x.js', `const a = require('./a'); function f() { return require('b') } module.exports = { a, f };`);
    assert.equal(module.kind, 'opaque');
    assert.deepEqual(module.kind === 'opaque' && module.specifiers.sort(), ['./a', 'b']);
  });

  test('a parse error falls back to an opaque module that still lists imports', () => {
    const { module, errors } = parseModule('x.ts', `import { a } from './a';\nexport const = ;`);
    assert.ok(errors.length > 0);
    assert.equal(module.kind, 'opaque');
    assert.ok(module.kind === 'opaque' && module.specifiers.includes('./a'));
  });
  test('computed imports keep their static parts as a pattern', () => {
    const m = esm(
      "export const a = (l) => import(`./messages/${l}.json`);\n" +
        "export const b = (l) => import('./locales/' + l + '.js');\n" +
        "export const c = (name) => import(name);\n" +
        "export const d = (l) => require(`../data/${l}/${l}.json`);",
      'x.ts'
    );
    assert.deepEqual([...(m.decls.get('a')?.usage.contexts ?? [])], ['./messages/*.json']);
    assert.deepEqual([...(m.decls.get('b')?.usage.contexts ?? [])], ['./locales/*.js']);
    assert.deepEqual([...(m.decls.get('c')?.usage.contexts ?? [])], ['*']);
    assert.deepEqual([...(m.decls.get('d')?.usage.contexts ?? [])], ['../data/*/*.json']);
  });

  test('paths in code: relative files, new URL, and joins on process.cwd() or __dirname', () => {
    const m = esm(
      "export const font = localFont({ src: './fonts/a.woff2' });\n" +
        "export const worker = () => new URL('worker.js', import.meta.url);\n" +
        "export const post = (slug) => join(process.cwd(), 'content', 'posts', `${slug}.md`);\n" +
        "export const data = () => path.join(process.cwd(), 'data/prices.json');\n" +
        "export const alias = path.resolve(__dirname, 'src');\n" +
        "export const link = './about';",
      'x.ts'
    );
    const paths = (name: string) => [...(m.decls.get(name)?.usage.paths ?? [])].map(p => p.replace('\0', ' '));
    assert.deepEqual(paths('font'), ['rel ./fonts/a.woff2']);
    assert.deepEqual(paths('worker'), ['file worker.js']);
    assert.deepEqual(paths('post'), ['cwd-tree content/posts']);
    assert.deepEqual(paths('data'), ['cwd data/prices.json']);
    assert.deepEqual(paths('alias'), ['file src']);
    assert.deepEqual(paths('link'), [], 'no extension, so not a file');
  });

  test('module directives are recorded', () => {
    assert.deepEqual(esm(`'use server';\nexport async function save() {}`, 'x.ts').directives, ['use server']);
    assert.deepEqual(esm(`export const a = 1;`, 'x.ts').directives, []);
  });
  test('import.meta.glob patterns and Hono serveStatic paths', () => {
    const m = esm(
      "export const pages = import.meta.glob(['./pages/*.tsx', '!./pages/_draft.tsx'], { eager: true });\n" +
        "export const assets = serveStatic({ root: './public' });\n" +
        "export const icon = serveStatic({ path: './favicon.ico' });\n" +
        "export const computed = (p) => import.meta.glob(p);",
      'x.ts'
    );
    const paths = (name: string) => [...(m.decls.get(name)?.usage.paths ?? [])].map(p => p.replace('\0', ' ').replace('\u0001', ' | '));
    assert.deepEqual(paths('pages'), ['glob ./pages/*.tsx | !./pages/_draft.tsx']);
    assert.deepEqual(paths('assets'), ['cwd ./public']);
    assert.ok(paths('icon').includes('cwd ././favicon.ico'), paths('icon').join());
    assert.deepEqual([...(m.decls.get('computed')?.usage.contexts ?? [])], ['*']);
  });
});
