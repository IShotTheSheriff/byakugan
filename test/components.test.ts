import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { affected, analyze } from '../src/index.ts';
import { app, write } from './helpers.ts';

const vue = `<script setup lang="ts">
import { Button } from './ui';
import { price } from './money';
import Child from './Child.vue';
</script>

<template>
  <img src="./logo.png" />
  <Button>{{ price(2) }}</Button>
  <Child />
</template>

<style lang="scss">
@import './theme';
</style>
`;
const svelte = `<script lang="ts">
  import { Button } from './ui';
  import { price } from './money';
</script>

<Button>{price(2)}</Button>
`;
const astro = `---
import { Button } from './ui';
import { price } from './money';
---
<Button>{price(2)}</Button>
`;

const files = (component: string, name: string) => ({
  'package.json': { name: 'app', private: true, type: 'module', dependencies: { vite: '6.0.0' } },
  'node_modules/vite/package.json': { name: 'vite', version: '6.0.0' },
  '.gitignore': 'node_modules/\n',
  'index.html': '<script type="module" src="/src/main.ts"></script>\n',
  'src/main.ts': `import App from './${name}';\nconsole.log(App);\n`,
  [`src/${name}`]: component,
  'src/Child.vue': '<template><p>child</p></template>\n',
  'src/money.ts': 'export const price = (n: number) => n * 2;\nexport const tax = (n: number) => n * 0.2;\n',
  'src/ui/index.ts': "export { Button } from './Button';\nexport { Card } from './Card';\n",
  'src/ui/Button.ts': "export const Button = 'button';\n",
  'src/ui/Card.ts': "export const Card = 'card';\n",
  'src/logo.png': 'png',
  'src/_theme.scss': '$c: red;\n',
});

const check = (component: string, name: string, edits: Record<string, string>) => {
  const dir = app(files(component, name), { repo: true });
  for (const [path, content] of Object.entries(edits)) write(dir, path, content);
  return affected({ cwd: dir, base: 'main' });
};

for (const [label, component, name] of [
  ['Vue', vue, 'App.vue'],
  ['Svelte', svelte, 'App.svelte'],
  ['Astro', astro, 'App.astro'],
] as const) {
  describe(`${label} components`, () => {
    test('a function the component imports counts', () => {
      const result = check(component, name, { 'src/money.ts': 'export const price = (n: number) => n * 3;\nexport const tax = (n: number) => n * 0.2;\n' });
      assert.equal(result.affected, true);
      assert.deepEqual(result.reasons.map(r => r.key), ['src/money.ts#price']);
    });

    test('an export next to it that nobody imports does not', () => {
      const result = check(component, name, { 'src/money.ts': 'export const price = (n: number) => n * 2;\nexport const tax = (n: number) => n * 0.3;\n' });
      assert.equal(result.affected, false);
    });

    test('a barrel sibling the component does not import does not count', () => {
      assert.equal(check(component, name, { 'src/ui/Card.ts': "export const Card = 'card!';\n" }).affected, false);
    });

    test('the component file counts whole', () => {
      assert.equal(check(component, name, { [`src/${name}`]: component.replace('price(2)', 'price(3)') }).affected, true);
    });
  });
}

describe('Vue template and style blocks', () => {
  test('an asset the template names, a child component and a style import count', () => {
    assert.equal(check(vue, 'App.vue', { 'src/logo.png': 'png2' }).affected, true);
    assert.equal(check(vue, 'App.vue', { 'src/Child.vue': '<template><p>kid</p></template>\n' }).affected, true);
    assert.equal(check(vue, 'App.vue', { 'src/_theme.scss': '$c: blue;\n' }).affected, true);
  });

  test('the graph lists the component and what it imports', () => {
    const dir = app(files(vue, 'App.vue'));
    const keys = [...analyze({ cwd: dir }).live.keys()];
    for (const key of ['src/App.vue', 'src/Child.vue', 'src/money.ts#price', 'src/logo.png', 'src/_theme.scss']) assert.ok(keys.includes(key), key);
    assert.ok(!keys.includes('src/money.ts#tax'));
  });
});

describe('component block parsing', () => {
  const keysWith = (component: string, extra: Record<string, string> = {}) => [...analyze({ cwd: app({ ...files(component, 'App.vue'), ...extra }) }).live.keys()];

  test('a > inside a script attribute does not end the tag', () => {
    const component = `<script setup lang="ts" generic="T extends Record<string, number>">\nimport { price } from './money';\n</script>\n<template><p>{{ price(1) }}</p></template>\n`;
    assert.ok(keysWith(component).includes('src/money.ts#price'));
  });

  test('a script inside an HTML comment is not code', () => {
    const component = `<!-- <script setup>import { price } from './money';</script> -->\n<template><p>x</p></template>\n`;
    assert.ok(!keysWith(component).includes('src/money.ts#price'));
  });

  test('a script that does not parse still has its imports followed', () => {
    const component = `<script setup lang="ts">\nimport { price } from './money';\nconst x = ;\n</script>\n<template><p>x</p></template>\n`;
    assert.ok(keysWith(component).some(k => k.startsWith('src/money.ts')));
  });

  test('srcset candidates and unquoted src values count, an absolute URL does not', () => {
    const component = `<template><img srcset="./a.png 1x, ./b.png 2x" /><img src=./c.png /><img src="https://x/d.png" /></template>\n`;
    const keys = keysWith(component, { 'src/a.png': 'a', 'src/b.png': 'b', 'src/c.png': 'c' });
    for (const key of ['src/a.png', 'src/b.png', 'src/c.png']) assert.ok(keys.includes(key), key);
  });

  test('env a Vue script reads counts by value', () => {
    const component = `<script setup lang="ts">\nconst url = import.meta.env.VITE_URL;\n</script>\n<template><p>{{ url }}</p></template>\n`;
    const dir = app(files(component, 'App.vue'));
    const read = (value: string) => {
      const saved = process.env.VITE_URL;
      process.env.VITE_URL = value;
      try {
        return analyze({ cwd: dir }).fingerprint();
      } finally {
        if (saved === undefined) delete process.env.VITE_URL;
        else process.env.VITE_URL = saved;
      }
    };
    assert.notEqual(read('a'), read('b'));
  });
});
