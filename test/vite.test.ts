import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyze, loadProject } from '../src/index.ts';
import { edit, write } from './helpers.ts';

const viteApp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'byakugan-vite-')));
  write(dir, 'package.json', '{ "name": "spa", "type": "module", "devDependencies": { "vite": "7.0.0", "@vitejs/plugin-react": "5.0.0" } }\n');
  write(dir, 'index.html', '<!doctype html>\n<div id="root"></div>\n<script type="module" src="/src/main.tsx"></script>\n');
  write(dir, 'vite.config.ts', "export default { plugins: [] };\n");
  write(dir, 'src/main.tsx', "import { App } from './App';\nimport './index.css';\n\ndocument.body.append(String(<App />));\n");
  write(dir, 'src/App.tsx', "import { title } from './copy';\n\nexport const App = () => <h1>{title}</h1>;\n");
  write(dir, 'src/copy.ts', "export const title = 'Hello';\nexport const footer = 'Bye';\n");
  write(dir, 'src/index.css', 'h1 { color: red; }\n');
  write(dir, 'public/robots.txt', 'User-agent: *\n');
  return dir;
};

test('Vite: entries come from index.html script tags and vite.config', () => {
  const dir = viteApp();
  const project = loadProject({ cwd: dir });
  assert.equal(project.framework, 'vite');
  assert.deepEqual(project.entries.map(e => e.slice(dir.length + 1)), ['src/main.tsx', 'vite.config.ts']);
  assert.deepEqual(project.packages, ['@vitejs/plugin-react', 'vite']);
  const keys = [...analyze({ cwd: dir }).live.keys()];
  for (const key of ['src/main.tsx#<module>', 'src/App.tsx#App', 'src/copy.ts#title', 'src/index.css', 'index.html', 'public/robots.txt']) {
    assert.ok(keys.includes(key), key);
  }
  assert.ok(!keys.includes('src/copy.ts#footer'));
});

test('Vite: an unused export does not change the fingerprint, the used one does', () => {
  const dir = viteApp();
  const before = analyze({ cwd: dir }).fingerprint();
  edit(dir, 'src/copy.ts', s => s.replace("'Bye'", "'Ciao'"));
  assert.equal(analyze({ cwd: dir }).fingerprint(), before);
  edit(dir, 'src/copy.ts', s => s.replace("'Hello'", "'Hi'"));
  assert.notEqual(analyze({ cwd: dir }).fingerprint(), before);
});
