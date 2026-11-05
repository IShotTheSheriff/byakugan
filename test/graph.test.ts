import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { analyze } from '../src/index.ts';
import { edit, fingerprintOf, fixture, liveKeys, write } from './helpers.ts';

describe('used graph', () => {
  const dir = fixture('basic');
  const keys = liveKeys(dir);

  test('follows a named lodash import to the per-method files only', () => {
    assert.ok(keys.includes('npm:lodash/partition.js'));
    assert.ok(keys.includes('npm:lodash/_createAggregator.js'));
    assert.ok(keys.includes('npm:lodash/_arrayAggregator.js'));
    assert.ok(!keys.includes('npm:lodash/filter.js'));
    assert.ok(!keys.includes('npm:lodash/_arrayFilter.js'));
    assert.ok(!keys.includes('npm:lodash/lodash.js'));
  });

  test('goes through an ESM barrel with sideEffects: false down to single declarations', () => {
    assert.ok(keys.includes('npm:es-utils/pick.js#pick'));
    assert.ok(keys.includes('npm:es-utils/internal.js#hasKey'));
    assert.ok(!keys.includes('npm:es-utils/internal.js#isObject'));
    assert.ok(!keys.some(k => k.startsWith('npm:es-utils/omit.js')));
    assert.ok(!keys.some(k => k.startsWith('npm:es-utils/keys.js')));
  });

  test('keeps only used declarations of a project file, plus what they reference', () => {
    assert.ok(keys.includes('src/utils.ts#formatDate'));
    assert.ok(keys.includes('src/utils.ts#pad'));
    assert.ok(keys.includes('src/utils.ts#cn'));
    assert.ok(!keys.includes('src/utils.ts#formatMoney'));
  });

  test('resolves `export *` barrels and tsconfig paths', () => {
    assert.ok(keys.includes('src/components/index.ts#export*:./Button'));
    assert.ok(keys.includes('src/components/Button.tsx#Button'));
    assert.ok(!keys.includes('src/components/index.ts#export*:./Modal'));
    assert.ok(!keys.some(k => k.startsWith('src/components/Modal.tsx')));
    assert.ok(!keys.some(k => k.startsWith('src/components/Card.tsx')));
  });

  test('narrows namespace imports to the members used', () => {
    assert.ok(keys.includes('src/strings.ts#upper'));
    assert.ok(!keys.includes('src/strings.ts#lower'));
  });

  test('follows type imports in project code', () => {
    assert.ok(keys.includes('src/types.ts#Props'));
    assert.ok(!keys.includes('src/types.ts#Unused'));
  });

  test('adds the implicit JSX runtime', () => {
    assert.ok(keys.includes('npm:react/jsx-runtime.js'));
  });

  test('reports nothing unresolved and no warnings', () => {
    const graph = analyze({ cwd: dir });
    assert.deepEqual(graph.unresolved, []);
    assert.deepEqual(graph.warnings, []);
  });
});

describe('fingerprint', () => {
  const cases: Array<[string, string, (s: string) => string, boolean]> = [
    ['lodash filter, which the app does not use', 'node_modules/lodash/filter.js', s => s.replace('arrayFilter(collection', 'arrayFilter(collection.slice()'), false],
    ['a lodash helper behind partition', 'node_modules/lodash/_arrayAggregator.js', s => s.replace('i++', 'i += 1'), true],
    ['the monolithic lodash.js', 'node_modules/lodash/lodash.js', s => s.replace('array.filter(predicate)', 'array.filter(p => predicate(p))'), false],
    ['an unused component behind a barrel', 'src/components/Modal.tsx', s => s.replace('formatMoney(10)', 'formatMoney(20)'), false],
    ['the used component behind a barrel', 'src/components/Button.tsx', s => s.replace("'primary'", "'secondary'"), true],
    ['an unused function next to a used one', 'src/utils.ts', s => s.replace('toFixed(2)', 'toFixed(3)'), false],
    ['a private helper of a used function', 'src/utils.ts', s => s.replace("padStart(2, '0')", "padStart(3, '0')"), true],
    ['a comment between declarations', 'src/utils.ts', s => s.replace('export function formatMoney', '// money\nexport function formatMoney'), false],
    ['an unused namespace member', 'src/strings.ts', s => s.replace('toLowerCase()', 'toLocaleLowerCase()'), false],
    ['an unused interface', 'src/types.ts', s => s.replace('x: number', 'x: string'), false],
    ['a used interface', 'src/types.ts', s => s.replace('label: string', 'label: string | number'), true],
    ['an unused export of an ESM package', 'node_modules/es-utils/omit.js', s => s.replace('!keys.includes(k)', 'keys.indexOf(k) < 0'), false],
    ['an unused helper in a used ESM package file', 'node_modules/es-utils/internal.js', s => s.replace("typeof value === 'object'", "typeof value == 'object'"), false],
    ['a used helper in an ESM package', 'node_modules/es-utils/internal.js', s => s.replace('Object.prototype.hasOwnProperty.call(object, key)', 'Object.hasOwn(object, key)'), true],
    ['displayName of an unused component', 'src/components/Modal.tsx', s => s.replace("'Modal'", "'Dialog'"), false],
    ['displayName of a used component', 'src/components/Button.tsx', s => s.replace("'Button'", "'Btn'"), true],
    ['a side effect in a module the barrel loads', 'src/components/Modal.tsx', s => `${s}\nconsole.log('loaded');\n`, true],
    ['a script in package.json', 'package.json', s => s.replace('"private": true', '"private": true,\n  "scripts": { "build": "next build" }'), true],
    ['tsconfig.json', 'tsconfig.json', s => s.replace('react-jsx', 'preserve'), true],
  ];

  for (const [what, path, change, affected] of cases) {
    test(`${affected ? 'changes' : 'stays the same'} when editing ${what}`, () => {
      const dir = fixture('basic');
      const before = fingerprintOf(dir);
      edit(dir, path, change);
      assert.equal(fingerprintOf(dir) !== before, affected);
    });
  }

  // The lockfile pins what installs. Without one, a range edit can install another version, and git mode would not see it.
  test('stays the same when editing a dependency range in package.json next to a lockfile', () => {
    const dir = fixture('basic');
    write(dir, 'package-lock.json', '{ "lockfileVersion": 3, "packages": {} }\n');
    const before = fingerprintOf(dir);
    edit(dir, 'package.json', s => s.replace('"lodash": "4.17.21"', '"lodash": "^4.17.21"'));
    assert.equal(fingerprintOf(dir), before);
  });

  test('changes when editing a dependency range in package.json without a lockfile', () => {
    const dir = fixture('basic');
    const before = fingerprintOf(dir);
    edit(dir, 'package.json', s => s.replace('"lodash": "4.17.21"', '"lodash": "^4.17.21"'));
    assert.notEqual(fingerprintOf(dir), before);
  });

  test('is stable across copies of the same project', () => {
    assert.equal(fingerprintOf(fixture('basic')), fingerprintOf(fixture('basic')));
  });
});
