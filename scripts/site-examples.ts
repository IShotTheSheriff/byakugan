// Renders docs/examples/*.md into site/examples.html, one section per page.
// `npm run site` writes the file. test/site.test.ts fails when the committed
// file no longer matches the markdown.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DOCS = join(ROOT, 'docs/examples');
const OUT = join(ROOT, 'site/examples.html');
const BLOB = 'https://github.com/IShotTheSheriff/byakugan/blob/main';

/**
 * The pages in site order: id, the short name the nav shows, the section heading (one italic
 * word, period inside, as on the landing page) and the tile tint, a different one per tile.
 */
const PAGES = [
  ['code', 'Code', 'Exports, barrels and <em>code.</em>', 'rose'],
  ['packages', 'Packages', 'Packages and <em>lockfiles.</em>', 'lilac'],
  ['styles', 'Styles', 'CSS, Sass and <em>Tailwind.</em>', 'sage'],
  ['files', 'Files', 'Renames, deletions and <em>links.</em>', 'sky'],
  ['frameworks', 'Frameworks', 'Frameworks and <em>workspaces.</em>', 'sand'],
  ['git-mode', 'Git mode', 'Git mode and <em>manifests.</em>', 'mint'],
] as const;

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\w\- ]/g, '')
    .trim()
    .replace(/ +/g, '-');

/** Where a link in docs/examples/<page>.md points on the site. */
const href = (target: string) => {
  const [file, anchor] = target.split('#');
  if (/^https?:/.test(target)) return target;
  if (file.startsWith('../../')) return `${BLOB}/${file.slice(6)}${anchor ? `#${anchor}` : ''}`;
  if (file.startsWith('../')) return `${BLOB}/docs/${file.slice(3)}${anchor ? `#${anchor}` : ''}`;
  const page = file.replace(/\.md$/, '');
  if (PAGES.some(([id]) => id === page)) return `#${anchor ? `${page}-${anchor}` : page}`;
  return `${BLOB}/docs/examples/${target}`;
};

/** Inline markdown: code spans and links. Everything else is text. */
const inline = (text: string): string => {
  let out = '';
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += escape(text.slice(last, m.index));
    if (m[1] !== undefined) out += `<code>${escape(m[1])}</code>`;
    else out += `<a href="${escape(href(m[3]))}">${inline(m[2])}</a>`;
    last = m.index + m[0].length;
  }
  return out + escape(text.slice(last));
};

/** Splits a table row on `|`, keeping `\|` as a literal pipe. */
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map(c => c.trim().replace(/\\\|/g, '|'));

const resultClass = (cell: string) => (/^unaffected\b/i.test(cell) ? ' class="no"' : /^affected\b/i.test(cell) ? ' class="yes"' : '');

const table = (rows: string[]) => {
  const head = cells(rows[0]);
  const result = head.findIndex(h => h.toLowerCase() === 'result');
  const test = head.findIndex(h => h.toLowerCase() === 'test');
  const body = rows.slice(2).map(r => {
    const tds = cells(r).map((c, i) => {
      const cls = i === result ? resultClass(c) : i === test ? ' class="ref"' : '';
      return `<td${cls}>${inline(c)}</td>`;
    });
    return `<tr>${tds.join('')}</tr>`;
  });
  const ths = head.map(h => `<th>${inline(h)}</th>`).join('');
  return `<div class="scroll"><table class="table"><thead><tr>${ths}</tr></thead><tbody>\n${body.join('\n')}\n</tbody></table></div>`;
};

interface Page {
  id: string;
  name: string;
  title: string;
  intro: string;
  topics: string;
  cases: number;
}

/** Converts the markdown subset docs/examples uses: headings, paragraphs, fenced code, tables. */
const page = (id: string, name: string): Page => {
  const lines = readFileSync(join(DOCS, `${id}.md`), 'utf8').split('\n');
  let title = '';
  let intro = '';
  const topics: string[] = [];
  let topic: string[] | null = null;
  let cases = 0;
  const emit = (html: string) => (topic ? topic.push(html) : (intro += `${html}\n`));
  const close = () => {
    if (topic) topics.push(`<article class="panel topic">\n${topic.join('\n')}\n</article>`);
    topic = null;
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      emit(`<pre class="code">${escape(body.join('\n'))}</pre>`);
    } else if (line.startsWith('|')) {
      const rows: string[] = [];
      for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
      cases += rows.length - 2;
      emit(table(rows));
    } else if (/^#{1,4} /.test(line)) {
      const level = line.indexOf(' ');
      const text = line.slice(level + 1);
      i++;
      if (level === 1) title = text;
      else if (level === 2) {
        close();
        topic = [`<h3 id="${id}-${slug(text)}"><a href="#${id}-${slug(text)}">${inline(text)}</a></h3>`];
      } else emit(`<h4>${inline(text)}</h4>`);
    } else if (line.trim() === '') i++;
    else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() !== '' && !/^(```|\||#{1,4} )/.test(lines[i]); i++) para.push(lines[i].trim());
      const text = para.join(' ');
      // The pages link back to the index, which this page replaces.
      if (text !== '[All examples](README.md)') emit(`<p>${inline(text)}</p>`);
    }
  }
  close();
  return { id, name, title, intro, topics: topics.join('\n'), cases };
};

export const render = () => {
  const pages = PAGES.map(([id, name, heading, tint]) => ({ ...page(id, name), heading, tint }));
  const total = pages.reduce((n, p) => n + p.cases, 0);
  const nav = pages.map(p => `<a class="nav-item" href="#${p.id}">${escape(p.name)}</a>`).join('');
  const tiles = pages
    .map(p => `<a class="tile ${p.tint} area" href="#${p.id}"><span class="area-title">${escape(p.name)}</span><span class="small">${inline(p.title)}</span><span class="muted small">${p.cases} cases</span></a>`)
    .join('\n');
  const sections = pages
    .map(
      p => `<section class="section area-section" id="${p.id}">
<div class="wrap">
<div class="section-head"><span class="eyebrow">${p.cases} cases</span><h2 class="display">${p.heading}</h2></div>
<div class="prose intro">
${p.intro}</div>
${p.topics}
</div>
</section>`
    )
    .join('\n');
  // Function replacers, so a `$'` or `$&` in the markdown stays literal text.
  return TEMPLATE.replace('{{nav}}', () => nav)
    .replace('{{tiles}}', () => tiles)
    .replace('{{sections}}', () => sections)
    .replaceAll('{{total}}', String(total));
};

const TEMPLATE = `<!doctype html>
<!-- Generated by scripts/site-examples.ts from docs/examples/*.md. Edit the markdown and run npm run site. -->
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>byakugan examples · what counts and what doesn't</title>
<meta name="description" content="{{total}} cases of a change and what byakugan says about it, from case-only renames to export * lines and Tailwind classes. Each one links to the test that asserts it.">
<meta property="og:title" content="byakugan examples">
<meta property="og:description" content="{{total}} cases of a change and its result, each linked to its test.">
<meta property="og:type" content="website">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='13' fill='%23F4EFE6' stroke='%231C1917' stroke-width='2'/%3E%3Ccircle cx='16' cy='16' r='4' fill='%23E8590C'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..600&family=JetBrains+Mono:wght@400..600&family=Doto:wght@700..900&family=Manrope:wght@400..700&display=swap" rel="stylesheet">
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="paper.css">
<script src="paper.js" defer></script>
<style>
  .scroll { overflow-x: auto; }
  .top { padding-top: 72px; }
  .top .section-head { margin-bottom: 0; }
  .search { display: flex; gap: 12px; align-items: center; margin: 32px auto 0; max-width: 560px; }
  .search input { flex: 1; min-width: 0; height: 46px; padding: 0 16px; border: 0; border-radius: 10px; background: var(--card); box-shadow: var(--hairline), var(--lift-1); color: var(--ink); font: 500 15px/1 var(--mono); }
  .search output { font: 500 13px/1 var(--sans); color: var(--ink-3); white-space: nowrap; }
  .areas { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 36px; text-align: left; }
  .area { gap: 4px; padding: 16px 18px; text-decoration: none; color: var(--ink); }
  .area-title { font: 360 24px/1.1 var(--serif); font-style: italic; letter-spacing: -0.02em; }
  .reading { margin-top: 24px; text-align: left; }
  .reading p + p { margin-top: 10px; }
  .area-section { padding-top: 96px; }
  .intro { max-width: 760px; margin: 0 auto 32px; font-size: 17px; }
  .topic { margin-top: 20px; scroll-margin-top: 90px; }
  .topic h3 { margin: 0 0 10px; font: 480 21px/1.3 var(--serif); scroll-margin-top: 90px; }
  .topic h3 a { color: inherit; text-decoration: none; }
  .topic h3 a:hover { text-decoration: underline; text-decoration-color: var(--rule-2); }
  .topic h4 { margin: 18px 0 8px; font: 600 15px/1.3 var(--sans); }
  .topic p { margin: 10px 0; color: var(--ink-2); max-width: 820px; }
  .topic .code { margin: 14px 0; font-size: 13px; }
  .topic .table { margin-top: 10px; font-size: 14.5px; }
  .table td { vertical-align: top; }
  .table code, .topic p code, .intro code, .reading code { font: 500 .88em/1.5 var(--mono); padding: 1px 5px; border-radius: 5px; background: var(--card-2); box-shadow: var(--hairline); overflow-wrap: anywhere; }
  .table td.ref { white-space: nowrap; font: 500 12.5px/1.5 var(--mono); }
  .table td.ref a { color: var(--ink-3); }
  .yes { color: var(--red); } .no { color: var(--green); }
  .yes::first-line, .no::first-line { font-weight: 600; }
  [hidden] { display: none !important; }
  @media (max-width: 900px) { .nav-item { padding: 0 9px; } }
  @media (max-width: 860px) { .areas { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 560px) { .areas { gap: 8px; } .area { padding: 12px 14px; } .area-title { font-size: 19px; } .area .small:not(.muted) { display: none; } .search { flex-direction: column; align-items: stretch; } .search input { flex: none; } .topic { padding: 16px; } }
</style>
</head>
<body>

<header class="nav">
  <div class="wrap nav-in">
    <a class="wordmark" href="./">byakugan</a>
    <nav class="nav-pill" aria-label="Examples">
      <i class="nav-hi" aria-hidden="true"></i>
      {{nav}}
    </nav>
    <a class="key key-sm" href="https://github.com/IShotTheSheriff/byakugan">GitHub <svg class="arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg></a>
  </div>
</header>

<main id="top">
  <section class="section top">
    <div class="wrap">
      <div class="section-head">
        <h1 class="display">Change this, see <em>that.</em></h1>
        <p class="lede">{{total}} changes and what byakugan says about each, linked to the test that checks it.</p>
      </div>
      <div class="search">
        <input id="q" type="search" placeholder="Search: export *, lockfile, Tailwind, rename..." aria-label="Search the examples" autocomplete="off">
        <output id="count" for="q">{{total}} cases</output>
      </div>
      <nav class="areas" aria-label="Sections">
{{tiles}}
      </nav>
      <div class="panel reading">
        <span class="eyebrow">Reading a row</span>
        <p><b class="yes">affected</b> means <code>byakugan affected --base main</code> reports a change, or the fingerprint moves. <b class="no">unaffected</b> means neither happens. Some rows name the reason key the test checks, such as <code>src/lib.ts#price</code> for one declaration or <code>npm:lodash</code> for a package. Rows run in the default <code>behavior</code> mode unless they say <code>strict</code>.</p>
        <p>Most cases come in pairs: a change that counts next to one that does not. Renaming <code>Hello.ts</code> to <code>hello.ts</code> is affected when <code>main.ts</code> imports <code>./Hello</code>. Renaming <code>Unused.ts</code> to <code>unused.ts</code> is not.</p>
      </div>
    </div>
  </section>

{{sections}}

  <section class="section">
    <div class="wrap narrow">
      <p class="center muted small">This page is generated from <a class="link" href="${BLOB}/docs/examples/README.md">docs/examples</a> in the repository. Known gaps are in <a class="link" href="${BLOB}/docs/limits.md">docs/limits.md</a>.</p>
    </div>
  </section>
</main>

<footer class="footer"><div class="wrap"><span>byakugan · MIT · <a href="https://github.com/IShotTheSheriff/byakugan">GitHub</a> · <a href="https://www.npmjs.com/package/byakugan-cli">npm</a></span><span>Not affiliated with Naruto or its publishers</span></div></footer>

<script>
(() => {
  const q = document.getElementById('q');
  const count = document.getElementById('count');
  const topics = [...document.querySelectorAll('.topic')];
  const sections = [...document.querySelectorAll('.area-section')];
  const text = new Map();
  const rowsOf = new Map(topics.map(t => [t, [...t.querySelectorAll('tbody tr')]]));
  const lower = el => { let s = text.get(el); if (s === undefined) { s = el.textContent.toLowerCase(); text.set(el, s); } return s; };
  const run = () => {
    const terms = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
    const hit = el => terms.every(t => lower(el).includes(t));
    let shown = 0;
    for (const t of topics) {
      const rows = rowsOf.get(t);
      const head = t.querySelector('h3');
      const whole = terms.length === 0 || hit(head);
      let any = false;
      for (const r of rows) { const ok = whole || hit(r); r.hidden = !ok; if (ok) { any = true; shown++; } }
      t.hidden = !any && !whole;
    }
    for (const s of sections) s.hidden = s.querySelectorAll('.topic:not([hidden])').length === 0;
    count.textContent = terms.length ? shown + ' of {{total}} cases' : '{{total}} cases';
  };
  q.addEventListener('input', run);
  if (q.value) run();
})();
</script>
</body>
</html>
`;

if (import.meta.main) {
  writeFileSync(OUT, render());
  console.log(`wrote ${OUT}`);
}
