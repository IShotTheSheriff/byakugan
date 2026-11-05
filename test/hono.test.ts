import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { affected, analyze, loadProject } from '../src/index.ts';
import { edit, git, initRepo, write } from './helpers.ts';

const HONO = {
  'node_modules/hono/package.json': '{ "name": "hono", "version": "4.0.0", "type": "module", "exports": { ".": "./index.js", "./cors": "./cors.js" } }',
  'node_modules/hono/index.js': 'export class Hono { get() { return this; } use() { return this; } }\n',
  'node_modules/hono/cors.js': 'export const cors = () => () => {};\n',
  'node_modules/wrangler/package.json': '{ "name": "wrangler", "version": "4.0.0" }',
};

const project = (files: Record<string, string>) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'byakugan-hono-')));
  for (const [path, content] of Object.entries({ ...HONO, '.gitignore': 'node_modules/\n', ...files })) write(dir, path, content);
  return dir;
};

const keysOf = (dir: string) => [...analyze({ cwd: dir }).live.keys()];

/** A Cloudflare Worker whose entry is not src/index.ts, serving static assets. */
const worker = () =>
  project({
    'package.json': '{ "name": "api", "type": "module", "dependencies": { "hono": "4.0.0" }, "devDependencies": { "wrangler": "4.0.0" } }',
    'wrangler.jsonc': '{\n  // comment\n  "main": "src/worker.ts",\n  "compatibility_date": "2026-01-01",\n  "assets": { "directory": "./static" }\n}\n',
    'src/worker.ts':
      "import { Hono } from 'hono';\nimport { env } from 'cloudflare:workers';\nimport { Database } from 'bun:sqlite';\nimport { routes } from './routes';\n\nexport default new Hono().get('/', () => routes(env, Database));\n",
    'src/routes.ts': "export const routes = (env, db) => [env, db];\nexport const unused = () => 'unused';\n",
    'static/logo.svg': '<svg/>\n',
  });

describe('Hono on Cloudflare Workers', () => {
  test('wrangler main is the entry, the config and assets are inputs, wrangler is tracked', () => {
    const dir = worker();
    const loaded = loadProject({ cwd: dir });
    assert.deepEqual(loaded.entries.map(e => e.slice(dir.length + 1)), ['src/worker.ts']);
    assert.ok(loaded.packages.includes('wrangler'));
    const graph = analyze({ cwd: dir });
    for (const key of ['wrangler.jsonc', 'static/logo.svg', 'src/routes.ts#routes', 'npm:hono/index.js#Hono']) assert.ok(graph.live.has(key), key);
    assert.ok(!graph.live.has('src/routes.ts#unused'));
  });

  test('runtime modules such as cloudflare:workers and bun:sqlite are not unresolved', () => {
    assert.deepEqual(analyze({ cwd: worker() }).unresolved, []);
  });

  test('a compatibility_date change is affected, a README change is not', () => {
    const dir = worker();
    write(dir, 'README.md', '# api\n');
    initRepo(dir);
    edit(dir, 'README.md', s => `${s}more\n`);
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, false);
    edit(dir, 'wrangler.jsonc', s => s.replace('2026-01-01', '2026-02-01'));
    assert.equal(affected({ cwd: dir, base: 'main' }).affected, true);
  });
});

describe('Hono on Node.js', () => {
  const node = () =>
    project({
      'package.json': '{ "name": "api", "type": "module", "dependencies": { "hono": "4.0.0" } }',
      'src/server.ts':
        "import { Hono } from 'hono';\nimport { cors } from 'hono/cors';\nimport { serveStatic } from '@hono/node-server/serve-static';\n\n" +
        "export const app = new Hono().use('*', cors()).use('/static/*', serveStatic({ root: './public' })).get('/favicon.ico', serveStatic({ path: './assets/favicon.ico' }));\n",
      'public/site.css': 'body { margin: 0 }\n',
      'assets/favicon.ico': 'ico\n',
      'assets/other.ico': 'other\n',
    });

  test('src/server.ts is an entry when package.json names none', () => {
    const dir = node();
    assert.deepEqual(loadProject({ cwd: dir }).entries.map(e => e.slice(dir.length + 1)), ['src/server.ts']);
  });

  test('serveStatic roots and paths are part of the graph', () => {
    const dir = node();
    const keys = keysOf(dir);
    assert.ok(keys.includes('public/site.css'));
    assert.ok(keys.includes('assets/favicon.ico'));
    assert.ok(!keys.includes('assets/other.ico'));
    const before = analyze({ cwd: dir }).fingerprint();
    write(dir, 'public/robots.txt', 'User-agent: *\n');
    assert.notEqual(analyze({ cwd: dir }).fingerprint(), before);
  });
});

describe('import.meta.glob and HonoX', () => {
  const honox = () =>
    project({
      'package.json': '{ "name": "site", "type": "module", "dependencies": { "hono": "4.0.0", "honox": "0.1.0", "vite": "7.0.0" } }',
      'node_modules/vite/package.json': '{ "name": "vite", "version": "7.0.0" }',
      'vite.config.ts': "export default { plugins: [{ client: { input: ['/app/client.ts', '/app/style.css'] } }] };\n",
      'app/server.ts': "export default import.meta.glob(['/app/pages/*.ts', '!/app/pages/_draft.ts'], { eager: true });\n",
      'app/client.ts': "export const hydrate = () => 'client';\n",
      'app/style.css': 'body { color: red }\n',
      'app/routes/index.tsx': 'export default () => null;\n',
      'app/pages/home.ts': "export const title = 'Home';\n",
      'app/pages/_draft.ts': "export const title = 'Draft';\n",
    });

  test('HonoX files and the Vite inputs named in vite.config are entries', () => {
    const dir = honox();
    const entries = loadProject({ cwd: dir }).entries.map(e => e.slice(dir.length + 1));
    for (const file of ['app/server.ts', 'app/client.ts', 'app/routes/index.tsx', 'app/style.css']) assert.ok(entries.includes(file), file);
  });

  test('import.meta.glob reaches matching files and honours negative patterns', () => {
    const keys = keysOf(honox());
    assert.ok(keys.includes('app/pages/home.ts#title'));
    assert.ok(!keys.includes('app/pages/_draft.ts#title'));
  });

  test('git mode: a deleted glob match and a deleted route are affected', () => {
    const dir = honox();
    initRepo(dir);
    renameSync(join(dir, 'app/pages/home.ts'), join(dir, 'home.ts.bak'));
    const result = affected({ cwd: dir, base: 'main' });
    assert.ok(result.reasons.some(r => r.key === 'app/pages/home.ts' && /computed import/.test(r.detail)), JSON.stringify(result.reasons));
    renameSync(join(dir, 'app/routes/index.tsx'), join(dir, 'index.tsx.bak'));
    assert.ok(affected({ cwd: dir, base: 'main' }).reasons.some(r => r.key === 'app/routes/index.tsx' && /entry/.test(r.detail)));
  });
});

describe('Hono RPC client in another app', () => {
  /**
   * apps/api runs a Hono server. apps/web imports only `type AppType` from it, so the server's
   * types count for web and its runtime code does not.
   */
  const rpc = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'byakugan-rpc-')));
    const files: Record<string, string> = {
      'package.json': '{ "name": "rpc", "private": true, "workspaces": ["apps/*"] }',
      '.gitignore': 'node_modules/\n',
      'node_modules/hono/package.json': '{ "name": "hono", "version": "4.0.0", "type": "module", "exports": { ".": "./index.js", "./client": "./client.js" } }',
      'node_modules/hono/index.js': 'export class Hono { get() { return this; } route() { return this; } }\n',
      'node_modules/hono/client.js': 'export const hc = () => ({});\n',
      'node_modules/hono/index.d.ts': 'export declare class Hono { get(path: string, handler: unknown): this; route(path: string, app: Hono): this; }\n',
      'node_modules/zod/package.json': '{ "name": "zod", "version": "4.0.0", "type": "module", "exports": "./index.js" }',
      'node_modules/zod/index.js': 'export const z = { string: () => ({}) };\n',
      'node_modules/@hono/node-server/package.json': '{ "name": "@hono/node-server", "version": "2.0.0", "type": "module", "exports": "./index.js" }',
      'node_modules/@hono/node-server/index.js': 'export const serve = () => {};\n',
      'node_modules/dotenv/package.json': '{ "name": "dotenv", "version": "17.0.0", "exports": { "./config": "./config.js" } }',
      'node_modules/dotenv/config.js': 'module.exports = {};\n',
      'apps/api/package.json': '{ "name": "@acme/api", "type": "module", "exports": "./src/index.ts", "dependencies": { "hono": "4.0.0", "zod": "4.0.0", "@hono/node-server": "2.0.0", "dotenv": "17.0.0" } }',
      'apps/api/src/index.ts':
        "import 'dotenv/config';\nimport { serve } from '@hono/node-server';\nimport { Hono } from 'hono';\nimport { products } from './products';\n\n" +
        "const app = new Hono().route('/products', products);\n\nexport type AppType = typeof app;\n\nserve({ fetch: app.fetch, port: 3001 });\n",
      'apps/api/src/products.ts':
        "import { Hono } from 'hono';\nimport { z } from 'zod';\nimport { listProducts } from './db';\n\nexport const products = new Hono().get('/', c => c.json(listProducts(z.string())));\n",
      'apps/api/src/db.ts': "export const listProducts = (schema: unknown) => [{ id: '1', schema }];\nexport const resetDatabase = () => 'reset';\n",
      'apps/web/package.json': '{ "name": "web", "type": "module", "dependencies": { "@acme/api": "*", "hono": "4.0.0" } }',
      'apps/web/byakugan.json': '{ "entry": ["src/main.ts"] }',
      'apps/web/src/main.ts': "import { hc } from 'hono/client';\nimport type { AppType } from '@acme/api';\n\nexport const client = hc<AppType>('/');\n",
      'package-lock.json': JSON.stringify(
        {
          name: 'rpc',
          lockfileVersion: 3,
          packages: {
            'node_modules/hono': { version: '4.0.0' },
            'node_modules/zod': { version: '4.0.0' },
            'node_modules/@hono/node-server': { version: '2.0.0' },
            'node_modules/dotenv': { version: '17.0.0' },
          },
        },
        null,
        2
      ),
    };
    for (const [path, content] of Object.entries(files)) write(dir, path, content);
    mkdirSync(join(dir, 'node_modules/@acme'));
    symlinkSync('../../apps/api', join(dir, 'node_modules/@acme/api'));
    initRepo(dir);
    return { dir, web: join(dir, 'apps/web'), api: join(dir, 'apps/api') };
  };
  const bump = (dir: string, name: string, from: string) =>
    edit(dir, 'package-lock.json', s => s.replace(`"node_modules/${name}": {\n      "version": "${from}"`, `"node_modules/${name}": {\n      "version": "9.9.9"`));

  test('the server is reached through types only: its packages count as types, its runtime-only packages not at all', () => {
    const { web } = rpc();
    const graph = analyze({ cwd: web });
    const keys = [...graph.live.keys()];
    assert.ok(keys.includes('apps/api/src/index.ts#AppType'));
    assert.ok(keys.includes('apps/api/src/products.ts#products'));
    assert.ok(keys.includes('npm:zod#<types>'), keys.join('\n'));
    assert.ok(!keys.includes('apps/api/src/index.ts#<module>'));
    assert.ok(!keys.some(k => k.startsWith('npm:@hono/node-server') || k.startsWith('npm:dotenv')), keys.join('\n'));
    assert.ok(!keys.includes('apps/api/src/db.ts#resetDatabase'));
  });

  test('server bootstrap changes do not affect the client; route and schema changes do', () => {
    const { dir, web } = rpc();
    const since = () => affected({ cwd: web, base: 'main' });
    edit(dir, 'apps/api/src/index.ts', s => s.replace('port: 3001', 'port: 3002').replace("import 'dotenv/config';\n", ''));
    bump(dir, '@hono/node-server', '2.0.0');
    edit(dir, 'apps/api/src/db.ts', s => s.replace("'reset'", "'wiped'"));
    assert.equal(since().affected, false, JSON.stringify(since().reasons));
    edit(dir, 'apps/api/src/db.ts', s => s.replace("id: '1'", "id: 1"));
    assert.equal(since().affected, true);
    git(dir, 'checkout', '-q', '.');
    bump(dir, 'zod', '4.0.0');
    assert.deepEqual(since().reasons.map(r => r.key), ['zod']);
  });

  test('the same bootstrap changes affect the server itself', () => {
    const { dir, api } = rpc();
    edit(dir, 'apps/api/src/index.ts', s => s.replace("import 'dotenv/config';\n", ''));
    assert.equal(affected({ cwd: api, base: 'main' }).affected, true);
    git(dir, 'checkout', '-q', '.');
    bump(dir, '@hono/node-server', '2.0.0');
    assert.equal(affected({ cwd: api, base: 'main' }).affected, true);
  });
});
