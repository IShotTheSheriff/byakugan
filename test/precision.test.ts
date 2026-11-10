import assert from 'node:assert/strict';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { affected, analyze } from '../src/index.ts';
import { app, liveKeys, pkg, write } from './helpers.ts';

/** Moves a file out of the project: git sees it as deleted. */
const remove = (dir: string, path: string) => {
  const trash = join(dir, '..', `${dir.split('/').pop()}-trash`);
  mkdirSync(trash, { recursive: true });
  renameSync(join(dir, path), join(trash, path.replaceAll('/', '_')));
};

/**
 * Commits `files` on main (src/main.ts is the entry unless `files` says otherwise), applies
 * `edits` to the working tree (null deletes) and returns git mode's answer and whether the
 * fingerprint moved.
 */
const compare = (files: Record<string, string | object>, edits: Record<string, string | null>) => {
  const dir = app(
    {
      'package.json': { name: 'app', private: true, type: 'module' },
      'byakugan.json': { entry: ['src/main.ts'] },
      '.gitignore': 'node_modules/\n',
      ...files,
    },
    { repo: true }
  );
  const before = analyze({ cwd: dir }).fingerprint();
  for (const [path, content] of Object.entries(edits)) {
    if (content === null) remove(dir, path);
    else write(dir, path, content);
  }
  const result = affected({ cwd: dir, base: 'main' });
  return { result, keys: result.reasons.map(r => r.key), moved: result.fingerprint !== before };
};

describe('git mode: exports that went away', () => {
  const lib = "export const price = (n: number) => n * 2;\nexport const other = 1;\n";
  const files = {
    'src/main.ts': "import { price } from './lib';\nconsole.log(price(2));\n",
    'src/lib.ts': lib,
  };

  test('deleting an export main.ts imports is affected', () => {
    const { result, keys } = compare(files, { 'src/lib.ts': 'export const other = 1;\n' });
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/lib.ts#price']);
  });

  test('deleting an export nobody imports is not affected', () => {
    const { result } = compare(files, { 'src/lib.ts': 'export const price = (n: number) => n * 2;\n' });
    assert.equal(result.affected, false);
  });

  test('dropping the export keyword of a declaration main.ts imports is affected', () => {
    const { result, keys } = compare(files, { 'src/lib.ts': lib.replace('export const price', 'const price') });
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/lib.ts#price']);
  });

  test('dropping the export keyword of a declaration nobody imports is not affected', () => {
    const { result } = compare(files, { 'src/lib.ts': lib.replace('export const other', 'const other') });
    assert.equal(result.affected, false);
  });

  test('renaming an export main.ts still imports by the old name is affected', () => {
    const { result } = compare(files, { 'src/lib.ts': lib.replace('price', 'cost') });
    assert.equal(result.affected, true);
  });

  test('deleting an export imported only as a type is affected', () => {
    const { result, keys } = compare(
      {
        'src/main.ts': "import type { Props } from './lib';\nexport const p: Props = { a: 1 };\n",
        'src/lib.ts': 'export interface Props { a: number }\nexport const other = 1;\n',
      },
      { 'src/lib.ts': 'export const other = 1;\n' }
    );
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/lib.ts#Props']);
  });

  describe('a file imported only as a type', () => {
    const files = {
      'src/main.ts': "import type { Props } from './lib';\nexport const p: Props = { a: 1 };\n",
      'src/lib.ts': 'export interface Props { a: number }\n',
      'src/spare.ts': 'export interface Spare { b: number }\n',
    };

    test('deleting it is affected, though the import that named it only warns now', () => {
      const { result, keys } = compare(files, { 'src/lib.ts': null });
      assert.equal(result.affected, true);
      assert.deepEqual(keys, ['src/lib.ts']);
    });

    test('deleting it behind lib/index.ts or a .js specifier is affected', () => {
      const index = compare({ 'src/main.ts': files['src/main.ts'], 'src/lib/index.ts': files['src/lib.ts'] }, { 'src/lib/index.ts': null });
      assert.equal(index.result.affected, true);
      const js = compare({ ...files, 'src/main.ts': files['src/main.ts'].replace('./lib', './lib.js') }, { 'src/lib.ts': null });
      assert.equal(js.result.affected, true);
    });

    test('deleting another file nothing imports is not affected', () => {
      const { result } = compare(files, { 'src/spare.ts': null });
      assert.equal(result.affected, false);
    });
  });

  describe('in an entry, where every export counts', () => {
    // A Next.js route handler: removing POST changes the routes the app serves.
    const entry = "export const revalidate = 60;\nexport function GET() { return 'ok'; }\nexport function POST() { return 'posted'; }\nconst spare = 1;\n";

    test('deleting an exported function is affected', () => {
      const { result, keys } = compare({ 'src/main.ts': entry }, { 'src/main.ts': entry.replace(/export function POST.*\n/, '') });
      assert.equal(result.affected, true);
      assert.deepEqual(keys, ['src/main.ts#POST']);
    });

    test('dropping the export keyword is affected', () => {
      const { result, keys } = compare({ 'src/main.ts': entry }, { 'src/main.ts': entry.replace('export const revalidate', 'const revalidate') });
      assert.equal(result.affected, true);
      assert.deepEqual(keys, ['src/main.ts#revalidate']);
    });

    test('deleting a local nothing uses is not affected', () => {
      const { result } = compare({ 'src/main.ts': entry }, { 'src/main.ts': entry.replace('const spare = 1;\n', '') });
      assert.equal(result.affected, false);
    });
  });

  describe('default exports', () => {
    const page = "export default function Page() { return 'page'; }\nexport const x = 1;\n";

    test('deleting a default export main.ts imports is affected', () => {
      const { result, keys } = compare(
        { 'src/main.ts': "import Page from './page';\nconsole.log(Page());\n", 'src/page.ts': page },
        { 'src/page.ts': 'export const x = 1;\n' }
      );
      assert.equal(result.affected, true);
      assert.deepEqual(keys, ['src/page.ts#Page']);
    });

    test('deleting a default export nobody imports is not affected', () => {
      const { result } = compare(
        { 'src/main.ts': "import { x } from './page';\nconsole.log(x);\n", 'src/page.ts': page },
        { 'src/page.ts': 'export const x = 1;\n' }
      );
      assert.equal(result.affected, false);
    });
  });

  describe('through import()', () => {
    const files = {
      'src/main.ts': "const m = await import('./lib');\nconsole.log(m);\n",
      'src/lib.ts': `${lib}const spare = 1;\n`,
    };

    test('deleting an export of a module loaded with import() is affected', () => {
      const { result, keys } = compare(files, { 'src/lib.ts': 'export const other = 1;\nconst spare = 1;\n' });
      assert.equal(result.affected, true);
      assert.deepEqual(keys, ['src/lib.ts#price']);
    });

    test('deleting a local nothing uses from that module is not affected', () => {
      const { result } = compare(files, { 'src/lib.ts': lib });
      assert.equal(result.affected, false);
    });
  });

  describe('through export *', () => {
    const files = {
      'src/main.ts': "import { price } from './index';\nconsole.log(price(2));\n",
      'src/index.ts': "export * from './lib';\n",
      'src/lib.ts': lib,
    };

    test('deleting an export main.ts imports through the barrel is affected', () => {
      const { result } = compare(files, { 'src/lib.ts': 'export const other = 1;\n' });
      assert.equal(result.affected, true);
    });

    test('dropping the export keyword behind the barrel is affected', () => {
      const { result } = compare(files, { 'src/lib.ts': lib.replace('export const price', 'const price') });
      assert.equal(result.affected, true);
    });

    test('deleting an export nobody imports through the barrel is not affected', () => {
      const { result } = compare(files, { 'src/lib.ts': 'export const price = (n: number) => n * 2;\n' });
      assert.equal(result.affected, false);
    });

    // A Next.js page that re-exports its route config: deleting revalidate changes how it renders.
    test('deleting an export an entry re-exports with export * is affected', () => {
      const { result } = compare(
        {
          'src/main.ts': "export * from './config';\nexport const GET = () => 'ok';\n",
          'src/config.ts': "export const revalidate = 60;\nexport const dynamic = 'force-static';\n",
        },
        { 'src/config.ts': "export const dynamic = 'force-static';\n" }
      );
      assert.equal(result.affected, true);
    });

    // export * never passes on a default export.
    test('deleting a default export of a module an entry re-exports with export * is not affected', () => {
      const { result } = compare(
        {
          'src/main.ts': "export * from './config';\n",
          'src/config.ts': 'export const revalidate = 60;\nexport default function unused() { return 1; }\n',
        },
        { 'src/config.ts': 'export const revalidate = 60;\n' }
      );
      assert.equal(result.affected, false);
    });

    describe('two hops and cycles behind an entry', () => {
      const chain = {
        'src/main.ts': "export * from './mid';\n",
        'src/mid.ts': "export * from './config';\n",
        'src/config.ts': 'export const revalidate = 60;\nexport const dynamic = 1;\nexport default function unused() { return 1; }\n',
      };

      test('deleting an export two export * hops away is affected', () => {
        const { result, keys } = compare(chain, { 'src/config.ts': 'export const dynamic = 1;\nexport default function unused() { return 1; }\n' });
        assert.equal(result.affected, true);
        assert.deepEqual(keys, ['src/config.ts#revalidate']);
      });

      test('deleting a default export two export * hops away is not affected', () => {
        const { result } = compare(chain, { 'src/config.ts': 'export const revalidate = 60;\nexport const dynamic = 1;\n' });
        assert.equal(result.affected, false);
      });

      test('deleting an export inside an export * cycle is affected', () => {
        const { result, keys } = compare(
          { 'src/main.ts': "export * from './a';\n", 'src/a.ts': "export * from './b';\nexport const a = 1;\n", 'src/b.ts': "export * from './a';\nexport const b = 2;\n" },
          { 'src/b.ts': "export * from './a';\n" }
        );
        assert.equal(result.affected, true);
        assert.deepEqual(keys, ['src/b.ts#b']);
      });

      test('deleting an export behind export * as ns and then export * is affected', () => {
        const { result, keys } = compare(
          { 'src/main.ts': "export * as ns from './lib';\n", 'src/lib.ts': "export * from './deep';\n", 'src/deep.ts': 'export const z = 1;\nexport const y = 2;\n' },
          { 'src/deep.ts': 'export const y = 2;\n' }
        );
        assert.equal(result.affected, true);
        assert.deepEqual(keys, ['src/deep.ts#z']);
      });

      test('renaming an export a sibling export * passes on, when main.ts reads another, is not affected', () => {
        const { result } = compare(
          {
            'src/main.ts': "import { a } from './barrel';\nconsole.log(a);\n",
            'src/barrel.ts': "export * from './one';\nexport * from './two';\n",
            'src/one.ts': 'export const a = 1;\n',
            'src/two.ts': 'export const b = 2;\n',
          },
          { 'src/two.ts': 'export const c = 2;\n' }
        );
        assert.equal(result.affected, false);
      });
    });
  });

  describe('through a namespace import read as ns.member', () => {
    const files = {
      'src/main.ts': "import * as ns from './lib';\nexport const r = ns.price(1);\n",
      'src/lib.ts': lib,
    };

    test('deleting the member main.ts reads is affected', () => {
      const { result, keys } = compare(files, { 'src/lib.ts': 'export const other = 1;\n' });
      assert.equal(result.affected, true);
      assert.deepEqual(keys, ['src/lib.ts#price']);
    });

    test('deleting a member main.ts does not read is not affected', () => {
      const { result } = compare(files, { 'src/lib.ts': 'export const price = (n: number) => n * 2;\n' });
      assert.equal(result.affected, false);
    });
  });

  // `export * as ns` counts the whole namespace, so only the coarse side has a test.
  test('deleting a member main.ts reads through export * as ns is affected', () => {
    const { result, keys } = compare(
      {
        'src/main.ts': "import { ns } from './barrel';\nexport const r = ns.price(1);\n",
        'src/barrel.ts': "export * as ns from './lib';\n",
        'src/lib.ts': lib,
      },
      { 'src/lib.ts': 'export const other = 1;\n' }
    );
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/lib.ts#price']);
  });
});

describe('decorators', () => {
  const dec = "export const Controller = (path: string) => (target: any) => { target.path = path; };\nexport const Input = (name: string) => (target: any, key: any) => {};\n";

  describe('written before export', () => {
    const files = {
      'src/main.ts': "import { UserController } from './users';\nconsole.log(UserController);\n",
      'src/dec.ts': dec,
      'src/users.ts': "import { Controller } from './dec';\n\n@Controller('/users')\nexport class UserController {}\n",
    };

    test('changing the argument counts', () => {
      const { result, keys, moved } = compare(files, {
        'src/users.ts': "import { Controller } from './dec';\n\n@Controller('/admin/users')\nexport class UserController {}\n",
      });
      assert.equal(moved, true);
      assert.equal(result.affected, true);
      assert.ok(keys.includes('src/users.ts#UserController'));
    });

    test('removing the decorator counts', () => {
      const { result, moved } = compare(files, { 'src/users.ts': "import { Controller } from './dec';\n\nexport class UserController {}\n" });
      assert.equal(moved, true);
      assert.equal(result.affected, true);
    });

    test('changing the argument before export default counts', () => {
      const { result, moved } = compare(
        {
          'src/main.ts': "import C from './users';\nconsole.log(C);\n",
          'src/dec.ts': dec,
          'src/users.ts': "import { Controller } from './dec';\n\n@Controller('/users')\nexport default class UserController {}\n",
        },
        { 'src/users.ts': "import { Controller } from './dec';\n\n@Controller('/admin')\nexport default class UserController {}\n" }
      );
      assert.equal(moved, true);
      assert.equal(result.affected, true);
    });
  });

  describe('in a module that runs but whose classes nobody imports', () => {
    // Decorators register routes and providers when the class is defined.
    const users = "import { Controller, Input } from './dec';\n\n@Controller('/users')\nexport class UserController {}\n\nexport class Plain { name = 'a'; }\n";
    const files = { 'src/main.ts': "import './users';\nexport {};\n", 'src/dec.ts': dec, 'src/users.ts': users };

    test('a class decorator counts', () => {
      const { result, moved } = compare(files, { 'src/users.ts': users.replace("'/users'", "'/admin'") });
      assert.equal(moved, true);
      assert.equal(result.affected, true);
    });

    test('a member decorator counts', () => {
      const { result, moved } = compare(files, {
        'src/users.ts': users.replace("export class Plain { name = 'a'; }", "export class Plain { @Input('b') name = 'a'; }"),
      });
      assert.equal(moved, true);
      assert.equal(result.affected, true);
    });

    test('a static block counts', () => {
      const withBlock = users.replace("export class Plain { name = 'a'; }", "export class Plain { static { console.log('a'); } }");
      const { result, moved } = compare({ ...files, 'src/users.ts': withBlock }, { 'src/users.ts': withBlock.replace("log('a')", "log('b')") });
      assert.equal(moved, true);
      assert.equal(result.affected, true);
    });

    test('a class without decorators or static blocks does not count', () => {
      const { result, moved } = compare(files, { 'src/users.ts': users.replace("name = 'a'", "name = 'b'") });
      assert.equal(moved, false);
      assert.equal(result.affected, false);
    });

    describe('on parameters', () => {
      /** users.ts with `body` as the class body of Plain, before and after 'a' becomes 'b'. */
      const plainWith = (body: string) => {
        const before = users.replace("export class Plain { name = 'a'; }", `export class Plain { ${body} }`);
        return compare({ ...files, 'src/users.ts': before }, { 'src/users.ts': before.replace("'a'", "'b'") });
      };

      test('a constructor parameter decorator counts', () => {
        const { result, moved } = plainWith("constructor(@Input('a') name: string) {}");
        assert.equal(moved, true);
        assert.equal(result.affected, true);
      });

      test('a decorator on a parameter property counts', () => {
        const { result, moved } = plainWith("constructor(@Input('a') private name: string) {}");
        assert.equal(moved, true);
        assert.equal(result.affected, true);
      });

      test('a method parameter decorator counts', () => {
        const { result, moved } = plainWith("handle(@Input('a') body: unknown) {}");
        assert.equal(moved, true);
        assert.equal(result.affected, true);
      });

      test('a constructor parameter without a decorator does not count', () => {
        const { result, moved } = plainWith("constructor(name = 'a') {}");
        assert.equal(moved, false);
        assert.equal(result.affected, false);
      });
    });
  });
});

describe('git mode: which modules an import runs', () => {
  const main = "import { Used } from './components';\nconsole.log(Used);\n";
  const plain = "export const Used = 1;\nexport const Unused = () => 0;\n";
  const importing = (from: string, name: string) => `import { ${name} } from '${from}';\nexport const Used = 1;\nexport const Unused = () => ${name};\n`;
  const modules = {
    'src/fancy.ts': "import './fancy.css';\nexport const Fancy = 'fancy';\n",
    'src/fancy.css': '.fancy { color: red }\n',
    'src/analytics.ts': "console.log('tracking');\nexport const track = 1;\n",
    'src/pure.ts': 'export const pure = 1;\n',
  };

  test('removing an import of a module with side effects is affected', () => {
    const { result, keys } = compare({ ...modules, 'src/main.ts': main, 'src/components.ts': importing('./fancy', 'Fancy') }, { 'src/components.ts': plain });
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/components.ts#<imports>']);
  });

  test('removing an import of a module that only declares things is not affected', () => {
    const { result } = compare({ ...modules, 'src/main.ts': main, 'src/components.ts': importing('./pure', 'pure') }, { 'src/components.ts': plain });
    assert.equal(result.affected, false);
  });

  test('adding an import of a module with side effects is affected', () => {
    const { result, keys } = compare({ ...modules, 'src/main.ts': main, 'src/components.ts': plain }, { 'src/components.ts': importing('./analytics', 'track') });
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/components.ts#<imports>']);
  });

  test('adding an import of a module that only declares things is not affected', () => {
    const { result } = compare({ ...modules, 'src/main.ts': main, 'src/components.ts': plain }, { 'src/components.ts': importing('./pure', 'pure') });
    assert.equal(result.affected, false);
  });

  test('adding an import of a module that imports one with side effects is affected', () => {
    const { result } = compare(
      { ...modules, 'src/mid.ts': "import { track } from './analytics';\nexport const mid = () => track;\n", 'src/main.ts': main, 'src/components.ts': plain },
      { 'src/components.ts': importing('./mid', 'mid') }
    );
    assert.equal(result.affected, true);
  });

  test('adding an import of a module unchanged code already runs is not affected', () => {
    const { result } = compare(
      { ...modules, 'src/main.ts': `import './analytics';\n${main}`, 'src/components.ts': plain },
      { 'src/components.ts': importing('./analytics', 'track') }
    );
    assert.equal(result.affected, false);
  });

  describe('packages', () => {
    const tracker = (manifest: object) => pkg('tracker', { type: 'module', main: 'index.js', ...manifest }, { 'index.js': "console.log('boot');\nexport const track = 1;\n" });

    test('adding an import of a package with top-level code is affected', () => {
      const { result } = compare({ ...tracker({}), 'src/main.ts': main, 'src/components.ts': plain }, { 'src/components.ts': importing('tracker', 'track') });
      assert.equal(result.affected, true);
    });

    test('adding an import of a sideEffects: false package is not affected', () => {
      const { result } = compare(
        { ...tracker({ sideEffects: false }), 'src/main.ts': main, 'src/components.ts': plain },
        { 'src/components.ts': importing('tracker', 'track') }
      );
      assert.equal(result.affected, false);
    });
  });

  describe('order', () => {
    const two = "import { a } from './a';\nimport { b } from './b';\nexport const Used = 1;\nexport const Unused = () => a + b;\n";
    const swapped = "import { b } from './b';\nimport { a } from './a';\nexport const Used = 1;\nexport const Unused = () => a + b;\n";

    test('reordering imports of modules with side effects is affected', () => {
      const { result, keys } = compare(
        { 'src/main.ts': main, 'src/components.ts': two, 'src/a.ts': "console.log('a');\nexport const a = 1;\n", 'src/b.ts': "console.log('b');\nexport const b = 1;\n" },
        { 'src/components.ts': swapped }
      );
      assert.equal(result.affected, true);
      assert.deepEqual(keys, ['src/components.ts#<imports>']);
    });

    test('reordering imports of modules that only declare things is not affected', () => {
      const { result } = compare(
        { 'src/main.ts': main, 'src/components.ts': two, 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' },
        { 'src/components.ts': swapped }
      );
      assert.equal(result.affected, false);
    });
  });

  describe('import() turned into a static import', () => {
    const lazy = (from: string) => `${main}export const load = () => import('${from}');\n`;

    test('one of a module with side effects changes the fingerprint', () => {
      const { result, moved } = compare({ ...modules, 'src/main.ts': lazy('./analytics'), 'src/components.ts': plain }, { 'src/components.ts': importing('./analytics', 'track') });
      assert.equal(moved, true);
      assert.equal(result.affected, true);
    });

    test('one of a module that only declares things changes nothing', () => {
      const { result, moved } = compare({ ...modules, 'src/main.ts': lazy('./pure'), 'src/components.ts': plain }, { 'src/components.ts': importing('./pure', 'pure') });
      assert.equal(moved, false);
      assert.equal(result.affected, false);
    });
  });

  describe('export type *', () => {
    const files = {
      'src/main.ts': "import type { Event } from './index';\nimport { track } from './index';\nexport const go = (e: Event) => track(e);\n",
      'src/index.ts': "export type * from './analytics';\nexport { track } from './track';\n",
      'src/analytics.ts': "console.log('analytics booted');\nexport interface Event { name: string }\n",
      'src/track.ts': 'export const track = (e: unknown) => e;\n',
    };

    test('turning it into export * is affected, since the target now runs', () => {
      const { result, keys, moved } = compare(files, { 'src/index.ts': "export * from './analytics';\nexport { track } from './track';\n" });
      assert.equal(moved, true);
      assert.equal(result.affected, true);
      assert.ok(keys.includes('src/index.ts#export*:./analytics'));
    });

    test('a side effect in a module reached only through it does not count', () => {
      const { result, moved } = compare(files, { 'src/analytics.ts': "console.log('analytics booted again');\nexport interface Event { name: string }\n" });
      assert.equal(moved, false);
      assert.equal(result.affected, false);
    });
  });
});

describe('member assignments', () => {
  test('one on a DOM node held in a local counts', () => {
    const before = "const root = document.documentElement;\nroot.dataset.theme = 'dark';\nexport {};\n";
    const { result, keys, moved } = compare({ 'src/main.ts': before }, { 'src/main.ts': before.replace("'dark'", "'light'") });
    assert.equal(moved, true);
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/main.ts#<module>']);
  });

  test('one on the result of a call counts', () => {
    const before = "const app = document.getElementById('app') as HTMLElement;\napp.innerHTML = '<p>a</p>';\nexport {};\n";
    const { result, moved } = compare({ 'src/main.ts': before }, { 'src/main.ts': before.replace('<p>a</p>', '<p>b</p>') });
    assert.equal(moved, true);
    assert.equal(result.affected, true);
  });

  describe('on declarations of a module that runs', () => {
    const ui = "function Modal() { return null; }\nModal.displayName = 'Modal';\nconst config: Record<string, unknown> = {};\nconfig.debug = true;\nexport const Used = 1;\n";
    const files = { 'src/main.ts': "import { Used } from './ui';\nconsole.log(Used);\n", 'src/ui.ts': ui };

    test('displayName of a function nothing uses does not count', () => {
      const { result, moved } = compare(files, { 'src/ui.ts': ui.replace("'Modal'", "'Dialog'") });
      assert.equal(moved, false);
      assert.equal(result.affected, false);
    });

    test('one on a fresh object nothing uses does not count', () => {
      const { result, moved } = compare(files, { 'src/ui.ts': ui.replace('debug = true', 'debug = false') });
      assert.equal(moved, false);
      assert.equal(result.affected, false);
    });

    test('one on a fresh object a used export reads counts', () => {
      const used = { ...files, 'src/main.ts': "import { config } from './ui';\nconsole.log(config);\n", 'src/ui.ts': ui.replace('const config', 'export const config') };
      const { result, keys, moved } = compare(used, { 'src/ui.ts': used['src/ui.ts'].replace('debug = true', 'debug = false') });
      assert.equal(moved, true);
      assert.equal(result.affected, true);
      assert.deepEqual(keys, ['src/ui.ts#config']);
    });
  });
});

describe('classic JSX', () => {
  const jsx = "export const h = (t: unknown, p: unknown) => ({ t, p });\nexport const f = (t: unknown, p: unknown) => [t, p];\nexport const Fragment = 'frag';\n";
  const editH = { 'src/jsx.ts': jsx.replace('({ t, p })', '({ t, p, v: 2 })') };
  const tsx = (files: Record<string, string | object>) => ({ 'byakugan.json': { entry: ['src/main.tsx'] }, 'src/jsx.ts': jsx, ...files });
  const config = (compilerOptions: object) => ({ 'tsconfig.json': { compilerOptions } });

  test('with jsx: react, editing the factory counts', () => {
    const { result, keys, moved } = compare(
      tsx({ ...config({ jsx: 'react', jsxFactory: 'h' }), 'src/main.tsx': "import { h } from './jsx';\nexport const App = () => <div />;\n" }),
      editH
    );
    assert.equal(moved, true);
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/jsx.ts#h']);
  });

  test('with jsx: react-jsx, editing an imported h nothing calls does not count', () => {
    const { result, moved } = compare(
      tsx({ ...config({ jsx: 'react-jsx' }), 'src/main.tsx': "import { h } from './jsx';\nexport const App = () => <div />;\n" }),
      editH
    );
    assert.equal(moved, false);
    assert.equal(result.affected, false);
  });

  test('with jsx: react and no jsxFactory, JSX uses React.createElement', () => {
    const react = "const React = { createElement: (...a: unknown[]) => a, Fragment: 'f' };\nexport default React;\n";
    const { result, moved } = compare(
      tsx({ ...config({ jsx: 'react' }), 'src/main.tsx': "import React from './react';\nexport const App = () => <div />;\n", 'src/react.ts': react }),
      { 'src/react.ts': react.replace('=> a,', '=> a.length,') }
    );
    assert.equal(moved, true);
    assert.equal(result.affected, true);
  });

  test('the fragment factory counts where JSX has a fragment', () => {
    const { result, keys } = compare(
      tsx({ ...config({ jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' }), 'src/main.tsx': "import { h, Fragment } from './jsx';\nexport const App = () => <><div /></>;\n" }),
      { 'src/jsx.ts': jsx.replace("'frag'", "'frag2'") }
    );
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/jsx.ts#Fragment']);
  });

  test('the fragment factory does not count where JSX has no fragment', () => {
    const { result, moved } = compare(
      tsx({ ...config({ jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' }), 'src/main.tsx': "import { h, Fragment } from './jsx';\nexport const App = () => <div />;\n" }),
      { 'src/jsx.ts': jsx.replace("'frag'", "'frag2'") }
    );
    assert.equal(moved, false);
    assert.equal(result.affected, false);
  });

  describe('pragmas', () => {
    test('with @jsx h, editing h counts', () => {
      const { result, moved } = compare(tsx({ 'src/main.tsx': "/** @jsx h */\nimport { h } from './jsx';\nexport const App = () => <div />;\n" }), editH);
      assert.equal(moved, true);
      assert.equal(result.affected, true);
    });

    test('with @jsx h, JSX in a component nothing uses does not use h', () => {
      const { result, moved } = compare(
        tsx({
          'src/main.tsx': "import { Used } from './ui';\nexport const App = () => Used;\n",
          'src/ui.tsx': "/** @jsx h */\nimport { h } from './jsx';\nexport const Used = 1;\nexport const Unused = () => <div />;\n",
        }),
        editH
      );
      assert.equal(moved, false);
      assert.equal(result.affected, false);
    });

    test('changing @jsx h to @jsx f counts', () => {
      const before = "/** @jsx h */\nimport { h, f } from './jsx';\nexport const App = () => <div />;\nexport { h, f };\n";
      const { result, keys, moved } = compare(tsx({ 'src/main.tsx': before }), { 'src/main.tsx': before.replace('@jsx h', '@jsx f') });
      assert.equal(moved, true);
      assert.equal(result.affected, true);
      assert.deepEqual(keys, ['src/main.tsx#<module>']);
    });

    test('adding @jsxImportSource counts', () => {
      const before = "export const App = () => <div className=\"a\" />;\n";
      const { result, moved } = compare(tsx({ 'src/main.tsx': before }), { 'src/main.tsx': `/** @jsxImportSource @emotion/react */\n${before}` });
      assert.equal(moved, true);
      assert.equal(result.affected, true);
    });

    test('adding a plain comment does not count', () => {
      const before = "export const App = () => <div className=\"a\" />;\n";
      const { result, moved } = compare(tsx({ 'src/main.tsx': before }), { 'src/main.tsx': `/** The app. */\n${before}` });
      assert.equal(moved, false);
      assert.equal(result.affected, false);
    });

    test('a pragma on its own line of a doc comment counts', () => {
      const before = "export const App = () => <div className=\"a\" />;\n";
      const { result, moved } = compare(tsx({ 'src/main.tsx': before }), {
        'src/main.tsx': `/**\n * The app.\n * @jsxImportSource @emotion/react\n */\n${before}`,
      });
      assert.equal(moved, true);
      assert.equal(result.affected, true);
    });

    test('editing a comment that mentions @jsx mid-sentence does not count', () => {
      const before = "// pass @jsx through the loader\nexport const App = () => <div />;\n";
      const { result, moved } = compare(tsx({ 'src/main.tsx': before }), { 'src/main.tsx': before.replace('loader', 'bundler') });
      assert.equal(moved, false);
      assert.equal(result.affected, false);
    });

    describe('and the automatic runtime', () => {
      const runtime = (source: string) =>
        liveKeys(
          app({
            'package.json': { name: 'app', type: 'module' },
            'byakugan.json': { entry: ['src/main.tsx'], jsxImportSource: 'emo' },
            'src/main.tsx': `${source}\nexport const App = () => <div />;\n`,
            ...pkg('emo', { exports: { './jsx-runtime': './jsx-runtime.js', './jsx-dev-runtime': './jsx-runtime.js' } }, { 'jsx-runtime.js': 'export const jsx = () => 1;\n' }),
          })
        ).filter(k => k.startsWith('npm:'));

      test('a comment that mentions @jsx mid-sentence keeps it', () => {
        assert.deepEqual(runtime('// pass @jsx through the loader'), ['npm:emo/jsx-runtime.js#jsx']);
      });

      test('@jsxRuntime classic drops it', () => {
        assert.deepEqual(runtime('/** @jsxRuntime classic */'), []);
      });
    });
  });
});

describe('verbatimModuleSyntax', () => {
  const theme = "document.documentElement.dataset.theme = 'dark';\nexport type Theme = 'dark' | 'light';\n";
  const editTheme = { 'src/theme.ts': theme.replace("'dark';", "'light';") };
  const inline = "import { type Theme } from './theme';\nexport const t: Theme = 'dark';\n";
  const verbatim = { 'tsconfig.json': { compilerOptions: { verbatimModuleSyntax: true } } };

  test('with it, import { type X } runs the module', () => {
    const { result, keys, moved } = compare({ ...verbatim, 'src/main.ts': inline, 'src/theme.ts': theme }, editTheme);
    assert.equal(moved, true);
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/theme.ts#<module>']);
  });

  test('without it, import { type X } does not run the module', () => {
    const { result, moved } = compare({ 'tsconfig.json': { compilerOptions: {} }, 'src/main.ts': inline, 'src/theme.ts': theme }, editTheme);
    assert.equal(moved, false);
    assert.equal(result.affected, false);
  });

  test('with it, import type still does not run the module', () => {
    const { result, moved } = compare(
      { ...verbatim, 'src/main.ts': "import type { Theme } from './theme';\nexport const t: Theme = 'dark';\n", 'src/theme.ts': theme },
      editTheme
    );
    assert.equal(moved, false);
    assert.equal(result.affected, false);
  });

  test('with it, export { type X } from runs the module', () => {
    const { result } = compare({ ...verbatim, 'src/main.ts': "export { type Theme } from './theme';\n", 'src/theme.ts': theme }, editTheme);
    assert.equal(result.affected, true);
  });

  test('an extended tsconfig can set it', () => {
    const { result, moved } = compare(
      {
        'tsconfig.base.json': { compilerOptions: { verbatimModuleSyntax: true } },
        'tsconfig.json': { extends: './tsconfig.base.json' },
        'src/main.ts': inline,
        'src/theme.ts': theme,
      },
      editTheme
    );
    assert.equal(moved, true);
    assert.equal(result.affected, true);
  });
});

describe('require.context', () => {
  const main = "const icons = require.context('./icons', false, /\\.svg$/);\nexport const names = icons.keys();\n";
  const files = { 'src/main.ts': main, 'src/icons/a.svg': '<svg>a</svg>\n', 'src/icons/b.svg': '<svg>b</svg>\n', 'src/other/c.svg': '<svg>c</svg>\n' };

  test('editing a file in the directory counts', () => {
    const { result, keys, moved } = compare(files, { 'src/icons/a.svg': '<svg>A</svg>\n' });
    assert.equal(moved, true);
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/icons/a.svg']);
  });

  test('editing a file outside the directory does not count', () => {
    const { result, moved } = compare(files, { 'src/other/c.svg': '<svg>C</svg>\n' });
    assert.equal(moved, false);
    assert.equal(result.affected, false);
  });

  test('deleting a file in the directory counts', () => {
    const { result } = compare(files, { 'src/icons/b.svg': null });
    assert.equal(result.affected, true);
    assert.match(result.reasons[0].detail, /inside a directory the code reads/);
  });

  test('adding a file to the directory counts', () => {
    const { result } = compare(files, { 'src/icons/d.svg': '<svg>d</svg>\n' });
    assert.equal(result.affected, true);
  });

  test('a call in a function nothing uses does not count', () => {
    const { result, moved } = compare(
      {
        ...files,
        'src/main.ts': "import { used } from './lib';\nexport const r = used;\n",
        'src/lib.ts': "export const used = 1;\nexport const icons = () => require.context('./icons', false, /\\.svg$/);\n",
      },
      { 'src/icons/a.svg': '<svg>A</svg>\n' }
    );
    assert.equal(moved, false);
    assert.equal(result.affected, false);
  });

  test('import.meta.webpackContext reads the directory too', () => {
    const { result, moved } = compare(
      { ...files, 'src/main.ts': "const icons = import.meta.webpackContext('./icons', { recursive: false });\nexport const names = icons.keys();\n" },
      { 'src/icons/a.svg': '<svg>A</svg>\n' }
    );
    assert.equal(moved, true);
    assert.equal(result.affected, true);
  });

  test('a computed directory warns', () => {
    const dir = app({
      'package.json': { name: 'app', type: 'module' },
      'byakugan.json': { entry: ['src/main.ts'] },
      'src/main.ts': "const dir = './icons';\nexport const icons = require.context(dir, false, /\\.svg$/);\n",
    });
    assert.ok(analyze({ cwd: dir }).warnings.some(w => w.startsWith('src/main.ts: cannot follow')));
  });
});

describe('import cycles', () => {
  /** `graph.effectful` for files nothing reaches, so the test picks which one is asked first. */
  const effectful = (files: Record<string, string>) => {
    const dir = app({ 'package.json': { name: 'app', type: 'module' }, 'byakugan.json': { entry: ['src/main.ts'] }, 'src/main.ts': 'export {};\n', ...files });
    const graph = analyze({ cwd: dir });
    return (path: string) => graph.effectful(join(dir, path));
  };
  const c = (effect: boolean) => `${effect ? "console.log('c');\n" : ''}export const c = 1;\n`;

  test('a module that reaches a side effect only through the cycle is effectful when asked first', () => {
    const ask = effectful({
      'src/a.ts': "import { b } from './b';\nimport { c } from './c';\nexport const a = () => [b, c];\n",
      'src/b.ts': "import { a } from './a';\nexport const b = () => a;\n",
      'src/c.ts': c(true),
    });
    assert.equal(ask('src/b.ts'), true);
    assert.equal(ask('src/a.ts'), true);
  });

  // b's side effect sits behind its second import: a must not be settled before b is.
  test('every member gets the same answer whichever is asked first', () => {
    const ask = effectful({
      'src/a.ts': "import { b } from './b';\nexport const a = () => b;\n",
      'src/b.ts': "import { a } from './a';\nimport { c } from './c';\nexport const b = () => [a, c];\n",
      'src/c.ts': c(true),
    });
    assert.equal(ask('src/b.ts'), true);
    assert.equal(ask('src/a.ts'), true);
  });

  test('a cycle with no side effects anywhere is not effectful', () => {
    const ask = effectful({
      'src/a.ts': "import { b } from './b';\nimport { c } from './c';\nexport const a = () => [b, c];\n",
      'src/b.ts': "import { a } from './a';\nexport const b = () => a;\n",
      'src/c.ts': c(false),
    });
    assert.equal(ask('src/b.ts'), false);
    assert.equal(ask('src/a.ts'), false);
  });

  describe('in git mode', () => {
    const files = (effect: boolean) => ({
      'src/main.ts': 'export const x = 1;\n',
      'src/a.ts': "import { b } from './b';\nimport { c } from './c';\nexport const a = () => [b, c];\n",
      'src/b.ts': "import { a } from './a';\nexport const b = () => a;\n",
      'src/c.ts': c(effect),
    });
    const addImport = { 'src/main.ts': "import { b } from './b';\nconst unused = () => b;\nexport const x = 1;\n" };

    test('adding an import of a module whose side effect is behind a cycle is affected', () => {
      const { result, keys } = compare(files(true), addImport);
      assert.equal(result.affected, true);
      assert.deepEqual(keys, ['src/main.ts#<imports>']);
    });

    test('adding an import of a cycle without side effects is not affected', () => {
      const { result } = compare(files(false), addImport);
      assert.equal(result.affected, false);
    });
  });
});

// Found while checking the fixes. Both resolve the removed import against the working tree.
describe('git mode: removed imports whose target also changed', () => {
  const files = {
    'src/main.ts': "import { Used } from './components';\nconsole.log(Used);\n",
    'src/components.ts': "import { Fancy } from './fancy';\nexport const Used = 1;\nexport const Unused = () => Fancy;\n",
    'src/fancy.ts': "console.log('fancy boot');\nexport const Fancy = 'fancy';\n",
  };

  test('deleting a module with side effects and its import is affected', () => {
    const { result } = compare(files, { 'src/components.ts': 'export const Used = 1;\n', 'src/fancy.ts': null });
    assert.equal(result.affected, true);
  });

  test('removing an import and the side effect of its target is affected', () => {
    const { result } = compare(files, { 'src/components.ts': 'export const Used = 1;\n', 'src/fancy.ts': "export const Fancy = 'fancy';\n" });
    assert.equal(result.affected, true);
  });

  test('removing an import of a module that only declares things, deleted with it, is not affected', () => {
    const { result } = compare(
      { ...files, 'src/components.ts': "import { pure } from './pure';\nexport const Used = 1;\nexport const Unused = () => pure;\n", 'src/pure.ts': 'export const pure = 1;\n' },
      { 'src/components.ts': 'export const Used = 1;\n', 'src/pure.ts': null }
    );
    assert.equal(result.affected, false);
  });

  test('removing an import of a sideEffects: false package is not affected', () => {
    const { result } = compare(
      {
        ...files,
        ...pkg('tracker', { type: 'module', main: 'index.js', sideEffects: false }, { 'index.js': "console.log('boot');\nexport const track = 1;\n" }),
        'src/components.ts': "import { track } from 'tracker';\nexport const Used = 1;\nexport const Unused = () => track;\n",
      },
      { 'src/components.ts': 'export const Used = 1;\n' }
    );
    assert.equal(result.affected, false);
  });

  describe('one import away', () => {
    // components.ts -> mid.ts (unchanged) -> fancy.ts, and the change drops the first import.
    const deep = {
      ...files,
      'src/components.ts': "import { mid } from './mid';\nexport const Used = 1;\nexport const Unused = () => mid;\n",
      'src/mid.ts': "import { Fancy } from './fancy';\nexport const mid = () => Fancy;\n",
    };

    test('removing the import while fancy.ts loses its side effect is affected', () => {
      const { result } = compare(deep, { 'src/components.ts': 'export const Used = 1;\n', 'src/fancy.ts': "export const Fancy = 'fancy';\n" });
      assert.equal(result.affected, true);
    });

    test('removing the import while fancy.ts is deleted is affected', () => {
      const { result } = compare(deep, { 'src/components.ts': 'export const Used = 1;\n', 'src/fancy.ts': null });
      assert.equal(result.affected, true);
    });
  });
});

// The removed import resolves, in the working tree, to a file this change added. The base
// side resolved it to another file, so that file is the one whose side effects went away.

describe('git mode: removed imports whose target this change renamed', () => {
  const files = {
    'src/main.ts': "import { Used } from './components';\nconsole.log(Used);\n",
    'src/components.ts': "import { Fancy } from './fancy';\nexport const Used = 1;\nexport const Unused = () => Fancy;\n",
    'src/fancy.ts': "console.log('fancy boot');\nexport const Fancy = 'fancy';\n",
  };
  const removed = { 'src/components.ts': 'export const Used = 1;\n' };

  test('renaming fancy.ts to fancy.tsx while removing its import is affected', () => {
    const { result, moved } = compare(files, { ...removed, 'src/fancy.ts': null, 'src/fancy.tsx': files['src/fancy.ts'] });
    assert.equal(moved, true);
    assert.equal(result.affected, true);
  });

  test('renaming a module that only declares things while removing its import is not affected', () => {
    const { result } = compare(
      { ...files, 'src/components.ts': "import { pure } from './pure';\nexport const Used = 1;\nexport const Unused = () => pure;\n", 'src/pure.ts': 'export const pure = 1;\n' },
      { ...removed, 'src/pure.ts': null, 'src/pure.tsx': 'export const pure = 1;\n' }
    );
    assert.equal(result.affected, false);
  });

  test('moving fancy/index.ts to fancy.ts while removing its import is affected', () => {
    const { 'src/fancy.ts': fancy, ...rest } = files;
    const { result, moved } = compare({ ...rest, 'src/fancy/index.ts': fancy }, { ...removed, 'src/fancy/index.ts': null, 'src/fancy.ts': fancy });
    assert.equal(moved, true);
    assert.equal(result.affected, true);
  });

  test('renaming the target behind a tsconfig alias while removing its import is affected', () => {
    const { result, moved } = compare(
      {
        ...files,
        'tsconfig.json': { compilerOptions: { paths: { '@/*': ['./src/*'] } } },
        'src/components.ts': "import { Fancy } from '@/fancy';\nexport const Used = 1;\nexport const Unused = () => Fancy;\n",
      },
      { ...removed, 'src/fancy.ts': null, 'src/fancy.tsx': files['src/fancy.ts'] }
    );
    assert.equal(moved, true);
    assert.equal(result.affected, true);
  });

  // mid.ts does not change, but its export * now reaches fancy.tsx, which has no side effect.
  test('renaming a target one export * away and dropping its side effect is affected', () => {
    const { result, moved } = compare(
      {
        ...files,
        'src/components.ts': "import { mid } from './mid';\nexport const Used = 1;\nexport const Unused = () => mid;\n",
        'src/mid.ts': "export * from './fancy';\nexport const mid = 1;\n",
      },
      { ...removed, 'src/fancy.ts': null, 'src/fancy.tsx': "export const Fancy = 'fancy';\n" }
    );
    assert.equal(moved, true);
    assert.equal(result.affected, true);
  });

  test('adding fancy.ts in front of fancy/index.ts while removing the import is affected', () => {
    const { 'src/fancy.ts': fancy, ...rest } = files;
    const { result, moved } = compare({ ...rest, 'src/fancy/index.ts': fancy }, { ...removed, 'src/fancy.ts': "export const Fancy = 'pure';\n" });
    assert.equal(moved, true);
    assert.equal(result.affected, true);
  });

  // ./fancy now resolves to fancy.js, which is unchanged. The base side ran the deleted fancy.ts.
  test('deleting fancy.ts so that ./fancy resolves to fancy.js while removing the import is affected', () => {
    const { result, moved } = compare({ ...files, 'src/fancy.js': "export const Fancy = 'js';\n" }, { ...removed, 'src/fancy.ts': null });
    assert.equal(moved, true);
    assert.equal(result.affected, true);
  });
});

// ESM runs imports depth first. a.ts runs x.ts before main.ts reaches y.ts, which imports t.ts.
// Once x.ts imports t.ts, t.ts runs before the body of x.ts. The walk is breadth first, so
// t.ts's first parent is y.ts, unchanged, and git mode takes the import as one that runs nothing new.
describe('git mode: an added import of a module unchanged code runs later', () => {
  const files = {
    'src/main.ts': "import './a';\nimport './y';\n",
    'src/a.ts': "import './x';\n",
    'src/x.ts': 'console.log((globalThis as any).flag);\nexport const k = 1;\n',
    'src/y.ts': "import { t } from './t';\nconsole.log(t);\n",
    'src/t.ts': '(globalThis as any).flag = 1;\nexport const t = 1;\n',
  };

  test('is affected, since the module now runs earlier', () => {
    const { result, moved } = compare(files, { 'src/x.ts': "import { t } from './t';\nconsole.log((globalThis as any).flag);\nexport const k = 1;\nexport const unused = () => t;\n" });
    assert.equal(moved, true);
    assert.equal(result.affected, true);
  });

  test('is not affected when unchanged code ran it first', () => {
    const { result } = compare(
      { ...files, 'src/main.ts': "import './y';\nimport './a';\n" },
      { 'src/x.ts': "import { t } from './t';\nconsole.log((globalThis as any).flag);\nexport const k = 1;\nexport const unused = () => t;\n" }
    );
    assert.equal(result.affected, false);
  });
});

describe('comments', () => {
  const lib = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';
  const files = { 'src/main.ts': "import { add } from './lib';\nconsole.log(add(1, 2));\n", 'src/lib.ts': lib };

  test('a comment inside a used function does not count', () => {
    const { result, moved } = compare(files, { 'src/lib.ts': lib.replace('  return', '  // the sum\n  return') });
    assert.equal(moved, false);
    assert.equal(result.affected, false);
  });

  test('a code change in the same function counts', () => {
    const { keys, moved } = compare(files, { 'src/lib.ts': lib.replace('a + b', 'a - b') });
    assert.equal(moved, true);
    assert.deepEqual(keys, ['src/lib.ts#add']);
  });

  test('@ts-expect-error inside it counts', () => {
    const { keys, moved } = compare(files, { 'src/lib.ts': lib.replace('  return', '  // @ts-expect-error\n  return') });
    assert.equal(moved, true);
    assert.deepEqual(keys, ['src/lib.ts#add']);
  });

  test('@ts-expect-error above an import counts, though no declaration holds it', () => {
    const { keys, moved } = compare(files, { 'src/main.ts': `// @ts-expect-error untyped\n${files['src/main.ts']}` });
    assert.equal(moved, true);
    assert.deepEqual(keys, ['src/main.ts#<module>']);
  });

  test('a plain comment above an import does not count', () => {
    const { result, moved } = compare(files, { 'src/main.ts': `// the entry\n${files['src/main.ts']}` });
    assert.equal(moved, false);
    assert.equal(result.affected, false);
  });

  describe('in JSX', () => {
    const view = 'export const View = () => (\n  <div>\n    <h1>Title</h1>\n    <p>Body</p>\n  </div>\n);\n';
    const jsx = { 'byakugan.json': { entry: ['src/main.tsx'] }, 'src/main.tsx': "import { View } from './view';\nexport const App = () => <View />;\n", 'src/view.tsx': view };

    test('a {/* note */} line in a used component does not count', () => {
      const { result, moved } = compare(jsx, { 'src/view.tsx': view.replace('    <p>', '    {/* the body */}\n    <p>') });
      assert.equal(moved, false);
      assert.equal(result.affected, false);
    });

    test('a text change in it counts', () => {
      const { keys, moved } = compare(jsx, { 'src/view.tsx': view.replace('Body', 'Body text') });
      assert.equal(moved, true);
      assert.deepEqual(keys, ['src/view.tsx#View']);
    });
  });

  describe('JSDoc in JavaScript', () => {
    const js = 'export const parse = (s) => {\n  /** @type {number} */\n  const n = Number(s);\n  return n;\n};\n';
    const files = (compilerOptions: object) => ({
      'byakugan.json': { entry: ['src/main.js'] },
      'tsconfig.json': { compilerOptions },
      'src/main.js': "import { parse } from './parse.js';\nconsole.log(parse('1'));\n",
      'src/parse.js': js,
    });
    const edited = { 'src/parse.js': js.replace('{number}', '{string}') };

    test('counts when tsconfig sets checkJs', () => {
      const { keys, moved } = compare(files({ allowJs: true, checkJs: true }), edited);
      assert.equal(moved, true);
      assert.deepEqual(keys, ['src/parse.js#parse']);
    });

    test('does not count when TypeScript does not check the file', () => {
      const { result, moved } = compare(files({ allowJs: true }), edited);
      assert.equal(moved, false);
      assert.equal(result.affected, false);
    });
  });

  describe('in CommonJS', () => {
    const legacy = "const base = 2;\nmodule.exports = (n) => n * base;\n";
    const cjs = { 'src/main.ts': "import double from './legacy.cjs';\nconsole.log(double(1));\n", 'src/legacy.cjs': legacy };

    test('a comment in a required file does not count', () => {
      const { result, moved } = compare(cjs, { 'src/legacy.cjs': `// old code\n${legacy.replace('base = 2;', 'base = 2; // why two')}` });
      assert.equal(moved, false);
      assert.equal(result.affected, false);
    });

    test('a code change in it counts', () => {
      const { result, moved } = compare(cjs, { 'src/legacy.cjs': legacy.replace('2', '3') });
      assert.equal(moved, true);
      assert.equal(result.affected, true);
    });
  });
});

describe('git mode: top-level initializers', () => {
  const lib = (store: string) =>
    `import { cva } from 'class-variance-authority';\nimport { createStore } from './store';\nexport const price = (n: number) => n * 2;\nexport const store = ${store};\nexport const variants = cva('a');\n`;
  const files = {
    'src/main.ts': "import { price } from './lib';\nconsole.log(price(2));\n",
    'src/lib.ts': lib("createStore('a')"),
    'src/store.ts': 'export const createStore = (name: string) => { (globalThis as any)[name] = {}; return name; };\n',
    ...pkg('class-variance-authority', { type: 'module', main: 'index.js' }, { 'index.js': 'export const cva = a => () => a;\n' }),
  };

  test('changing a call nobody reads the result of is affected, since it runs with the module', () => {
    const { result, keys } = compare(files, { 'src/lib.ts': lib("createStore('b')") });
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/lib.ts#store']);
  });

  test('a store nobody reads pulls in the code its initializer calls', () => {
    const { result } = compare(files, { 'src/store.ts': 'export const createStore = (name: string) => name;\n' });
    assert.equal(result.affected, true);
  });

  test('changing an unused cva() call is not affected, since it only builds a value', () => {
    const { result } = compare(files, { 'src/lib.ts': lib("createStore('a')").replace("cva('a')", "cva('b')") });
    assert.equal(result.affected, false);
  });

  test('changing an unused call marked #__PURE__ is not affected', () => {
    const { result } = compare(
      { ...files, 'src/lib.ts': lib("/*#__PURE__*/ createStore('a')") },
      { 'src/lib.ts': lib("/*#__PURE__*/ createStore('b')") }
    );
    assert.equal(result.affected, false);
  });

  test('changing an unused object literal or arrow function is not affected', () => {
    const base = 'export const price = 1;\nexport const config = { a: [1, 2].map(n => n * 2) };\nexport const later = () => createStore();\n';
    const { result } = compare(
      { ...files, 'src/lib.ts': base },
      { 'src/lib.ts': base.replace('n * 2', 'n * 3').replace('createStore()', 'createStore(1)') }
    );
    assert.equal(result.affected, false);
  });

  test('a callback map() runs right away counts', () => {
    const base = "import { createStore } from './store';\nexport const price = 1;\nexport const all = ['a'].map(n => createStore(n));\n";
    const { result } = compare({ ...files, 'src/lib.ts': base }, { 'src/lib.ts': base.replace("['a']", "['b']") });
    assert.equal(result.affected, true);
  });

  test('a function passed as a callback runs: map(register) counts', () => {
    const base = "import { createStore } from './store';\nconst register = (n: string) => createStore(n);\nexport const price = 1;\nexport const all = ['a'].map(register);\n";
    const counted = compare({ ...files, 'src/lib.ts': base }, { 'src/lib.ts': base.replace("['a']", "['b']") });
    assert.equal(counted.result.affected, true);
    const plain = "const register = (n: string) => n;\nexport const price = 1;\nexport const all = ['a'].map(register);\n";
    const free = compare({ ...files, 'src/lib.ts': plain }, { 'src/lib.ts': plain.replace("['a']", "['b']") });
    assert.equal(free.result.affected, false, 'a callback that only builds a value is still pure');
  });

  test('a borrowed method that mutates counts: Array.prototype.push.call', () => {
    const store = "export const list: string[] = [];\nexport const createStore = (name: string) => name;\n";
    const base = "import { list } from './store';\nexport const price = 1;\nexport const n = Array.prototype.push.call(list, 'a');\n";
    const { result } = compare({ ...files, 'src/store.ts': store, 'src/lib.ts': base }, { 'src/lib.ts': base.replace("'a')", "'b')") });
    assert.equal(result.affected, true);
    const pure = "export const price = 1;\nexport const n = Array.isArray(['a']);\n";
    const free = compare({ ...files, 'src/lib.ts': pure }, { 'src/lib.ts': pure.replace("['a']", "['b']") });
    assert.equal(free.result.affected, false, 'a pure static method is not');
  });

  test('a static class field that calls a function counts, an unused plain one does not', () => {
    const base = "import { createStore } from './store';\nexport const price = 1;\nexport class A { static s = createStore('a'); static n = 1; }\n";
    const counted = compare({ ...files, 'src/lib.ts': base }, { 'src/lib.ts': base.replace("'a'", "'b'") });
    assert.equal(counted.result.affected, true);
    const plain = "export const price = 1;\nexport class A { static n = 1; }\n";
    const free = compare({ ...files, 'src/lib.ts': plain }, { 'src/lib.ts': plain.replace('n = 1', 'n = 2') });
    assert.equal(free.result.affected, false);
  });
});

describe('git mode: declaration order', () => {
  const lib = 'export const base = 1;\nexport const price = base * 2;\nexport const other = 3;\n';
  const files = {
    'src/main.ts': "import { price } from './lib';\nconsole.log(price);\n",
    'src/lib.ts': lib,
  };

  test('moving a binding below the initializer that reads it is affected', () => {
    const { result, keys } = compare(files, { 'src/lib.ts': 'export const price = base * 2;\nexport const base = 1;\nexport const other = 3;\n' });
    assert.equal(result.affected, true);
    assert.deepEqual(keys, ['src/lib.ts#price']);
  });

  test('moving an unrelated declaration is not affected', () => {
    const { result } = compare(files, { 'src/lib.ts': 'export const other = 3;\nexport const base = 1;\nexport const price = base * 2;\n' });
    assert.equal(result.affected, false);
  });

  test('moving a base class below its subclass is affected', () => {
    const base = 'class A {}\nexport class B extends A {}\n';
    const { result } = compare(
      { 'src/main.ts': "import { B } from './lib';\nnew B();\n", 'src/lib.ts': base },
      { 'src/lib.ts': 'export class B extends A {}\nclass A {}\n' }
    );
    assert.equal(result.affected, true);
  });

  test('moving a function declaration is not affected, since it is hoisted', () => {
    const base = 'function f() { return 1; }\nexport const price = f();\n';
    const { result } = compare(
      { 'src/main.ts': "import { price } from './lib';\nconsole.log(price);\n", 'src/lib.ts': base },
      { 'src/lib.ts': 'export const price = f();\nfunction f() { return 1; }\n' }
    );
    assert.equal(result.affected, false);
  });

  test('moving a binding below a top-level statement that reads it is affected', () => {
    const base = 'const x = 1;\nconsole.log(x);\nexport {};\n';
    const { result } = compare({ 'src/main.ts': "import './lib';\n", 'src/lib.ts': base }, { 'src/lib.ts': 'console.log(x);\nconst x = 1;\nexport {};\n' });
    assert.equal(result.affected, true);
  });

  test('a reference inside a function body does not care about order', () => {
    const base = 'export const price = () => base;\nconst base = 1;\n';
    const { result } = compare(
      { 'src/main.ts': "import { price } from './lib';\nconsole.log(price());\n", 'src/lib.ts': base },
      { 'src/lib.ts': 'const base = 1;\nexport const price = () => base;\n' }
    );
    assert.equal(result.affected, false);
  });
});

describe('TypeScript syntax that runs', () => {
  const main = { 'src/main.ts': "import { price } from './lib';\nconsole.log(price);\n" };
  const reg = 'const reg = (n: number) => { (globalThis as any).n = n; return n; };\nexport const price = 1;\n';

  test('an enum initializer that calls a function runs with the module', () => {
    const lib = `${reg}export enum Level { Low = reg(1) }\n`;
    const { result } = compare({ ...main, 'src/lib.ts': lib }, { 'src/lib.ts': lib.replace('reg(1)', 'reg(2)') });
    assert.equal(result.affected, true);
  });

  test('an unused enum of constants does not count', () => {
    const lib = 'export const price = 1;\nexport enum Level { Low = 1, High = Low * 2 }\n';
    const { result } = compare({ ...main, 'src/lib.ts': lib }, { 'src/lib.ts': lib.replace('Low = 1', 'Low = 3') });
    assert.equal(result.affected, false);
  });

  test('a statement in a namespace body runs with the module', () => {
    const lib = `${reg}export namespace Setup { reg(1); }\n`;
    const { result } = compare({ ...main, 'src/lib.ts': lib }, { 'src/lib.ts': lib.replace('reg(1)', 'reg(2)') });
    assert.equal(result.affected, true);
  });

  test('an unused namespace that only declares things does not count', () => {
    const lib = 'export const price = 1;\nexport namespace Shapes { export const sides = 4; export const area = (n: number) => n * n; export interface Box { w: number } }\n';
    const { result } = compare({ ...main, 'src/lib.ts': lib }, { 'src/lib.ts': lib.replace('sides = 4', 'sides = 5').replace('n * n', 'n + n') });
    assert.equal(result.affected, false);
  });

  describe('a file whose only module syntax is import x = require()', () => {
    const files = {
      'src/main.ts': "import lib = require('./lib');\nconsole.log(lib.price);\n",
      'src/lib.ts': 'export const price = 1;\nexport const other = 2;\n',
    };

    test('a change to the member it reads is affected', () => {
      const { result, keys } = compare(files, { 'src/lib.ts': files['src/lib.ts'].replace('price = 1', 'price = 3') });
      assert.equal(result.affected, true);
      assert.deepEqual(keys, ['src/lib.ts#price']);
    });

    test('a change to a member it does not read is not affected', () => {
      const { result } = compare(files, { 'src/lib.ts': files['src/lib.ts'].replace('other = 2', 'other = 4') });
      assert.equal(result.affected, false);
    });
  });
});
