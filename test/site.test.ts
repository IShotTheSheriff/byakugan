import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { render } from '../scripts/site-examples.ts';

const ROOT = join(import.meta.dirname, '..');

test('site/examples.html matches docs/examples (run npm run site)', () => {
  assert.ok(readFileSync(join(ROOT, 'site/examples.html'), 'utf8') === render(), 'site/examples.html is out of date: run npm run site');
});

test('site/examples.html has one section per examples page and every case', () => {
  const html = render();
  for (const id of ['code', 'packages', 'styles', 'files', 'frameworks', 'git-mode']) assert.match(html, new RegExp(`<section class="section area-section" id="${id}">`));
  assert.equal(html.split('<footer').length, 2);
  // Every test link in the markdown, collapsed rows included, reaches the page.
  const dir = join(ROOT, 'docs/examples');
  const links = readdirSync(dir).flatMap(f => [...readFileSync(join(dir, f), 'utf8').matchAll(/\]\(\.\.\/\.\.\/(test\/[^)]+)\)/g)].map(m => m[1]));
  assert.ok(links.length > 800, `${links.length} links`);
  const missing = links.filter(l => !html.includes(`/blob/main/${l}"`));
  assert.deepEqual(missing, []);
});

test('every test link in docs/examples lands on a test or a table row', () => {
  const dir = join(ROOT, 'docs/examples');
  const files = new Map<string, string[]>();
  const wrong: string[] = [];
  for (const page of readdirSync(dir).filter(f => f.endsWith('.md'))) {
    for (const [, file, line] of readFileSync(join(dir, page), 'utf8').matchAll(/\]\(\.\.\/\.\.\/(test\/[^)#]+)#L(\d+)\)/g)) {
      if (!files.has(file)) files.set(file, readFileSync(join(ROOT, file), 'utf8').split('\n'));
      const text = files.get(file)![Number(line) - 1] ?? '';
      if (!/test\(|^\s*[[{'"`]/.test(text)) wrong.push(`${page}: ${file}:${line} is "${text.trim()}"`);
    }
  }
  assert.ok(files.size > 10);
  assert.deepEqual(wrong, []);
});
