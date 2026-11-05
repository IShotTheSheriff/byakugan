// Runs in a child process started by `runTailwind` (tailwind.ts). Reads a TailwindRequest
// on stdin, runs the project's own Tailwind for each root stylesheet, and writes
// TailwindResult[] to stdout.
//
// Both sides of a git comparison go through the same steps: list the files Tailwind scans,
// extract candidates from their contents (or from `overrides`), build CSS with a fresh compiler.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import picomatch from 'picomatch';
import { globSync } from 'tinyglobby';
import type { TailwindRequest, TailwindResult } from './tailwind.ts';

// Tailwind and its plugins may log. Stdout carries the result.
console.log = console.info = (...args: unknown[]) => process.stderr.write(`${args.join(' ')}\n`);

type Require = ReturnType<typeof createRequire>;
interface Source {
  base: string;
  pattern: string;
  negated: boolean;
}
interface Item {
  content: string;
  extension: string;
}

const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp[34]|webm|mov|wav|ogg|pdf|zip|gz|wasm|node)$/i;
const HOSTS = ['@tailwindcss/postcss', '@tailwindcss/turbopack', '@tailwindcss/vite', '@tailwindcss/webpack', '@tailwindcss/cli'];

const request = JSON.parse(readFileSync(0, 'utf8')) as TailwindRequest;
const overrides = new Map(Object.entries(request.overrides ?? {}));

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 20);
const load = async (path: string) => (await import(pathToFileURL(path).href)) as Record<string, any>;

const contentOf = (file: string): string | undefined => {
  if (overrides.has(file)) return overrides.get(file) ?? undefined;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return;
  }
};

const STYLESHEET = /\.(css|scss|sass|less|styl|pcss)$/;

/** `skipStyles`: v4 takes no class names from stylesheets (only CSS variables), so neither do we. */
const items = (files: string[], skipStyles = false): Item[] => {
  const out: Item[] = [];
  for (const file of files) {
    if (skipStyles && STYLESHEET.test(file)) continue;
    const content = contentOf(file);
    if (content !== undefined) out.push({ content, extension: extname(file).slice(1) });
  }
  return out;
};

/** Files deleted from disk that the base side still has. Tailwind would have scanned them if `inScope`. */
const deleted = (scanned: string[], inScope: (file: string) => boolean) => {
  const seen = new Set(scanned);
  return [...overrides]
    .filter(([file, content]) => content !== null && !seen.has(file) && !BINARY.test(file) && !file.endsWith('.css') && inScope(file))
    .map(([file]) => file)
    .sort();
};

const posix = (path: string) => path.split(sep).join('/');

/**
 * Matches absolute paths against globs taken relative to `base`. A pattern with no glob
 * characters names a file or a directory, and a directory means everything under it.
 */
const scope = (globs: Array<{ base: string; pattern: string }>) => {
  const patterns = globs.flatMap(({ base, pattern }) => {
    const absolute = posix(resolve(base, pattern));
    return picomatch.scan(pattern).isGlob ? [absolute] : [absolute, `${absolute}/**`];
  });
  const matches = picomatch(patterns, { dot: true });
  return (file: string) => matches(posix(file));
};

const packageDir = (from: string, name: string) => {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`cannot find ${name} from ${from}`);
  }
};

const resolveTailwindPackage = (require: Require, name: string): string => {
  try {
    return require.resolve(name);
  } catch {}
  for (const host of HOSTS) {
    try {
      return createRequire(require.resolve(host)).resolve(name);
    } catch {}
  }
  throw new Error(`cannot find ${name}; it ships with @tailwindcss/postcss, /vite and /turbopack`);
};

const v4 = async (root: string, require: Require) => {
  const nodePath = resolveTailwindPackage(require, '@tailwindcss/node');
  const { compile } = await load(nodePath);
  let oxidePath: string;
  try {
    oxidePath = createRequire(nodePath).resolve('@tailwindcss/oxide');
  } catch {
    oxidePath = resolveTailwindPackage(require, '@tailwindcss/oxide');
  }
  const { Scanner } = await load(oxidePath);
  const deps: string[] = [];
  const compiler = await compile(readFileSync(root, 'utf8'), {
    from: root,
    base: dirname(root),
    onDependency: (dep: string) => deps.push(dep),
  });
  const extraSources: Source[] = compiler.sources ?? (compiler.globs ?? []).map((g: Source) => ({ ...g, negated: false }));
  const rootSource: Source[] =
    compiler.root === 'none' ? [] : compiler.root ? [{ ...compiler.root, negated: false }] : [{ base: request.dir, pattern: '**/*', negated: false }];
  const sources = [...rootSource, ...extraSources];
  const scanner = new Scanner({ sources });
  scanner.scan();
  const files = [...(scanner.files as string[])].sort();
  const extra = deleted(files, scope(sources.filter(s => !s.negated)));
  const candidates = (new Scanner({ sources: [] }).scanFiles(items([...files, ...extra], true)) as string[]).sort();
  return { hash: sha(compiler.build(candidates) as string), files, deps };
};

const POSTCSS_CONFIGS = ['postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs', 'postcss.config.ts', '.postcssrc', '.postcssrc.json', '.postcssrc.js', '.postcssrc.cjs'];

/** The PostCSS config text, read but not run: it only tells which plugins and Tailwind config the build uses. */
const postcssConfig = (): { dir: string; text: string } | undefined => {
  for (const name of POSTCSS_CONFIGS) {
    const file = join(request.dir, name);
    if (existsSync(file)) return { dir: request.dir, text: readFileSync(file, 'utf8') };
  }
};

/** `tailwindcss: { config }`, `tailwindcss({ config })` or `require('tailwindcss')({ config })` in the PostCSS config. */
const configFromPostcss = (postcss: { dir: string; text: string } | undefined) => {
  const match = postcss && /tailwindcss['"]?\)?\s*[:(]\s*\{[^}]{0,500}?\bconfig\s*:\s*['"]([^'"]+)['"]/.exec(postcss.text);
  return match && postcss ? resolve(postcss.dir, match[1]) : undefined;
};

const isRegularFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * `@import`s inlined the way Vite's built-in postcss-import does: relative files, files under the
 * project root (`/src/x.css`) and package stylesheets, each once. `url()` may leave out the quotes.
 */
const inlineImports = (file: string, css: string, seen = new Set<string>()): string => {
  seen.add(file);
  const rule = /@import\s+(?:url\(\s*(['"]?)([^'")\s]+)\1\s*\)|(['"])([^'"\n]+)\3)[^;\n]*;/g;
  return css.replace(rule, (text, _q1: string, url: string | undefined, _q2: string, quoted: string | undefined) => {
    const spec = (url ?? quoted) as string;
    if (/^[a-z][\w+.-]*:|^\/\//i.test(spec)) return text;
    let target: string | undefined;
    const base = spec.startsWith('/') ? request.dir : dirname(file);
    const local = spec.startsWith('/') ? `.${spec}` : spec;
    if (/^[./]/.test(spec)) target = [resolve(base, local), resolve(base, `${local}.css`)].find(isRegularFile);
    else {
      for (const candidate of [spec, `${spec}.css`]) {
        try {
          target = createRequire(file).resolve(candidate);
          break;
        } catch {}
      }
    }
    if (!target || !target.endsWith('.css')) return text;
    if (seen.has(target)) return '';
    return inlineImports(target, readFileSync(target, 'utf8'), seen);
  });
};

/** A v3 root written in Sass: PostCSS sees what Sass compiles, partials inlined. */
const compileSass = (root: string): string => {
  const project = createRequire(join(request.dir, 'package.json'));
  let sass: { compile: (file: string, options: object) => { css: string } };
  try {
    sass = project('sass');
  } catch {
    sass = project('sass-embedded');
  }
  return sass.compile(root, { loadPaths: [request.dir, join(request.dir, 'node_modules')] }).css;
};

const v3 = async (root: string, tailwindDir: string) => {
  const local = createRequire(join(tailwindDir, 'package.json'));
  const tailwind = local(tailwindDir);
  const postcss = local('postcss');
  const loadConfigModule = local(join(tailwindDir, 'loadConfig.js'));
  const loadConfig = loadConfigModule.default ?? loadConfigModule;
  const css = /\.s[ac]ss$/.test(root) ? compileSass(root) : readFileSync(root, 'utf8');
  const postcssFile = postcssConfig();
  const configRef = /@config\s+['"]([^'"]+)['"]/.exec(css)?.[1];
  const configPath = configRef
    ? resolve(dirname(root), configRef)
    : (configFromPostcss(postcssFile) ?? ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map(e => join(request.dir, `tailwind.config.${e}`)).find(existsSync));
  const config = configPath ? loadConfig(configPath) : {};
  const content = Array.isArray(config.content) ? { files: config.content } : (config.content ?? { files: [] });
  const base = content.relative && configPath ? dirname(configPath) : request.dir;
  const globs = (content.files as unknown[]).filter((f): f is string => typeof f === 'string');
  const raw = (content.files as unknown[]).filter(f => typeof f !== 'string');
  // Globs may be absolute (`path.join(__dirname, ...)` in the config). Make them relative so one glob call takes them all.
  const relativeGlobs = globs.map(g => {
    const negated = g.startsWith('!');
    const body = negated ? g.slice(1) : g;
    const rel = isAbsolute(body) ? posix(relative(base, body)) || '.' : body;
    return (negated ? '!' : '') + rel;
  });
  const files = relativeGlobs.length > 0 ? globSync(relativeGlobs, { cwd: base, absolute: true }).sort() : [];
  const inScope = scope(relativeGlobs.filter(g => !g.startsWith('!')).map(pattern => ({ base, pattern })));
  const extra = deleted(files, inScope);
  const scanned = items([...files, ...extra]).map(i => ({ raw: i.content, extension: i.extension }));
  const plugin = () => tailwind({ ...config, content: { ...content, files: [...raw, ...scanned] } });
  // With postcss-import (named in the PostCSS config, or built into Vite), `@import`ed files are
  // inlined before Tailwind runs, so it sees one stylesheet. Without it, the bundler runs PostCSS
  // on each imported file on its own.
  const members = request.members?.[root] ?? [root];
  const postcssImport = postcssFile !== undefined && /postcss-import/.test(postcssFile.text);
  let output = '';
  if (postcssImport) {
    const plugins = [createRequire(join(request.dir, 'package.json'))('postcss-import')(), plugin()];
    output = (await postcss(plugins).process(css, { from: root })).css as string;
  } else if (request.inlineImports) {
    output = (await postcss([plugin()]).process(inlineImports(root, css), { from: root })).css as string;
  } else if (/\.s[ac]ss$/.test(root) || (members.length === 1 && members[0] === root)) {
    // Sass already put the members into `css`.
    output = (await postcss([plugin()]).process(css, { from: root })).css as string;
  } else {
    for (const member of members) output += `${(await postcss([plugin()]).process(readFileSync(member, 'utf8'), { from: member })).css as string}\n`;
  }
  return { hash: sha(output), files, deps: configPath ? [configPath] : [] };
};

const results: TailwindResult[] = [];
for (const root of request.roots) {
  try {
    const tailwindDir = packageDir(root, 'tailwindcss');
    const version = String((JSON.parse(readFileSync(join(tailwindDir, 'package.json'), 'utf8')) as { version?: unknown }).version);
    const outcome = Number.parseInt(version, 10) >= 4 ? await v4(root, createRequire(root)) : await v3(root, tailwindDir);
    results.push({ file: root, version, ...outcome });
  } catch (error) {
    results.push({ file: root, files: [], deps: [], error: String((error as Error).message ?? error).split('\n')[0] });
  }
}
process.stdout.write(JSON.stringify(results));
