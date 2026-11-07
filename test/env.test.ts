import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { affected, analyze, createManifest, summarize } from '../src/index.ts';
import { parseModule } from '../src/parse.ts';
import { app, write } from './helpers.ts';

const envOf = (source: string) => {
  const m = parseModule('x.ts', source).module;
  assert.equal(m.kind, 'esm');
  const names = new Set<string>();
  for (const d of m.decls.values()) for (const n of d.usage.env) names.add(n);
  for (const n of m.effects.usage.env) names.add(n);
  return [...names].sort();
};

/** Runs `run` with the environment variables in `vars` set, then restores them. */
const withEnv = <T>(vars: Record<string, string | undefined>, run: () => T): T => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  const set = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  set(vars);
  try {
    return run();
  } finally {
    set(saved);
  }
};

describe('environment variables in code', () => {
  test('the parser reads names off process.env and import.meta.env', () => {
    assert.deepEqual(
      envOf(
        "export const a = process.env.NEXT_PUBLIC_A;\nexport const b = process.env['B'];\nexport const c = import.meta.env.VITE_C;\nconst { D, E: e } = process.env;\nconsole.log(process.env?.F, D, e);\n"
      ),
      ['B', 'D', 'E', 'F', 'NEXT_PUBLIC_A', 'VITE_C']
    );
  });

  test('a computed name and env passed whole are not names', () => {
    assert.deepEqual(envOf('const k = "X";\nexport const a = process.env[k];\nexport const all = process.env;\n'), []);
  });

  const project = () =>
    app({
      'package.json': { name: 'app', private: true, type: 'module', dependencies: { next: '15.0.0' } },
      'node_modules/next/package.json': { name: 'next', version: '15.0.0' },
      'app/page.tsx': "import { url } from '../lib/config';\nexport default function Page() { return url; }\n",
      'lib/config.ts': 'export const url = process.env.NEXT_PUBLIC_URL;\nexport const unused = process.env.NEXT_PUBLIC_UNUSED;\nexport const secret = process.env.SECRET;\n',
    });

  test('a NEXT_PUBLIC_ value live code reads counts', () => {
    const dir = project();
    const a = withEnv({ NEXT_PUBLIC_URL: 'https://a' }, () => analyze({ cwd: dir }).fingerprint());
    const b = withEnv({ NEXT_PUBLIC_URL: 'https://b' }, () => analyze({ cwd: dir }).fingerprint());
    assert.notEqual(a, b);
  });

  test('setting a variable only unused code reads, or one outside the inlined prefix, does not count', () => {
    const dir = project();
    const a = withEnv({ NEXT_PUBLIC_UNUSED: '1', SECRET: '1' }, () => analyze({ cwd: dir }).fingerprint());
    const b = withEnv({ NEXT_PUBLIC_UNUSED: '2', SECRET: '2' }, () => analyze({ cwd: dir }).fingerprint());
    assert.equal(a, b);
  });

  test('"env" in byakugan.json makes a variable count by value', () => {
    const dir = project();
    write(dir, 'lib/config.ts', 'export const url = process.env.API_URL;\n');
    write(dir, 'byakugan.json', JSON.stringify({ env: ['API_*'] }));
    const a = withEnv({ API_URL: 'a' }, () => analyze({ cwd: dir }).fingerprint());
    const b = withEnv({ API_URL: 'b' }, () => analyze({ cwd: dir }).fingerprint());
    assert.notEqual(a, b);
  });

  test('a manifest saved with another value reports the variable', () => {
    const dir = project();
    const base = withEnv({ NEXT_PUBLIC_URL: 'https://a' }, () => createManifest(analyze({ cwd: dir })));
    const result = withEnv({ NEXT_PUBLIC_URL: 'https://b' }, () => affected({ cwd: dir, baseManifest: base }));
    assert.equal(result.affected, true);
    assert.deepEqual(result.reasons.map(r => r.key), ['env:NEXT_PUBLIC_URL']);
  });

  test('import.meta.env used whole counts every inlined variable, not others', () => {
    const dir = app({
      'package.json': { name: 'app', private: true, type: 'module', dependencies: { vite: '6.0.0' } },
      'node_modules/vite/package.json': { name: 'vite', version: '6.0.0' },
      'index.html': '<script type="module" src="/src/main.ts"></script>\n',
      'src/main.ts': 'const env = import.meta.env;\nconsole.log(env);\n',
    });
    const print = (vars: Record<string, string>) => withEnv(vars, () => analyze({ cwd: dir }).fingerprint());
    assert.notEqual(print({ VITE_A: '1' }), print({ VITE_A: '2' }));
    assert.equal(print({ SECRET_A: '1' }), print({ SECRET_A: '2' }));
  });

  test('graph lists what code reads and what counts', () => {
    const dir = project();
    const summary = summarize(analyze({ cwd: dir }));
    assert.deepEqual(summary.env, { read: ['NEXT_PUBLIC_URL'], counted: ['NEXT_PUBLIC_URL'] });
  });
});
