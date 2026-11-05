// Runs in a child process started by `runTailwind` (tailwind.ts). Reads a TailwindRequest
// on stdin, runs the project's own Tailwind for each root stylesheet, and writes
// TailwindResult[] to stdout.
//
// Both sides of a git comparison go through the same steps: list the files Tailwind scans,
// extract candidates from their contents (or from `overrides`), build CSS with a fresh compiler.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
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

const items = (files: string[]): Item[] => {
  const out: Item[] = [];
  for (const file of files) {
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
  const bases = sources.filter(s => !s.negated).map(s => resolve(s.base));
  const extra = deleted(files, file => bases.some(base => file.startsWith(base + sep)));
  const candidates = (new Scanner({ sources: [] }).scanFiles(items([...files, ...extra])) as string[]).sort();
  return { hash: sha(compiler.build(candidates) as string), files, deps };
};

const v3 = async (root: string, tailwindDir: string) => {
  const local = createRequire(join(tailwindDir, 'package.json'));
  const tailwind = local(tailwindDir);
  const postcss = local('postcss');
  const loadConfigModule = local(join(tailwindDir, 'loadConfig.js'));
  const loadConfig = loadConfigModule.default ?? loadConfigModule;
  const css = readFileSync(root, 'utf8');
  const configRef = /@config\s+['"]([^'"]+)['"]/.exec(css)?.[1];
  const configPath = configRef
    ? resolve(dirname(root), configRef)
    : ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map(e => join(request.dir, `tailwind.config.${e}`)).find(existsSync);
  const config = configPath ? loadConfig(configPath) : {};
  const content = Array.isArray(config.content) ? { files: config.content } : (config.content ?? { files: [] });
  const base = content.relative && configPath ? dirname(configPath) : request.dir;
  const globs = (content.files as unknown[]).filter((f): f is string => typeof f === 'string');
  const raw = (content.files as unknown[]).filter(f => typeof f !== 'string');
  const files = globs.length > 0 ? globSync(globs, { cwd: base, absolute: true }).sort() : [];
  const matches = picomatch(globs.filter(g => !g.startsWith('!')).map(g => g.replace(/^\.\//, '')));
  const extra = deleted(files, file => matches(relative(base, file).split(sep).join('/')));
  const scanned = items([...files, ...extra]).map(i => ({ raw: i.content, extension: i.extension }));
  const result = await postcss([tailwind({ ...config, content: { ...content, files: [...raw, ...scanned] } })]).process(css, { from: root });
  return { hash: sha(result.css as string), files, deps: configPath ? [configPath] : [] };
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
