import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { readRegular, readText, stripBlocks } from './fs.ts';
import { globMatcher, OS_FILES, safeGlob } from './glob.ts';
import { parseJsonc } from './jsonc.ts';
import {
  GLOB_SEPARATOR,
  componentModule,
  componentParts,
  mdxModule,
  parseModule,
  type EsmModule,
  type ModuleInfo,
  type ModuleRequest,
  type ParseOptions,
  type PathKind,
  type Usage,
} from './parse.ts';
import { tsconfigFiles, type Project } from './project.ts';
import { findStyleFile, isInNodeModules, packageNameOf, Resolver, styleCandidates, type PackageInfo } from './resolve.ts';
import { isTailwindRoot, runTailwind, tailwindFallbackFiles, type TailwindRequest, type TailwindResult } from './tailwind.ts';

const JS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
/** Single-file components: a template plus `<script>` and `<style>` blocks. */
const COMPONENT_EXTENSIONS = new Set(['.vue', '.svelte', '.astro']);
export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const SEP = '\u0000';
/** Marker export name: every export of the module but `default` matters, because an `export *` that is used whole passes them on. */
const STAR_EXPORTS = '\u0001*';
/** An input's hash. With a lockfile, dependency ranges in package.json are left out: installed versions count instead. */
/** The target text of a symlink to a directory, or undefined for anything else. */
const linkedDirectory = (file: string): string | undefined => {
  try {
    return lstatSync(file).isSymbolicLink() && statSync(file).isDirectory() ? readlinkSync(file) : undefined;
  } catch {
    return;
  }
};

export const inputHash = (file: string, content: Buffer | string, filterDependencies: boolean): string => {
  if (filterDependencies && basename(file) === 'package.json') {
    try {
      const manifest = parseJsonc(content.toString());
      if (typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)) {
        const copy = { ...(manifest as Record<string, unknown>) };
        for (const field of DEPENDENCY_FIELDS) delete copy[field];
        return hashOf(JSON.stringify(copy));
      }
    } catch {}
  }
  return hashOf(content);
};

/**
 * `*` matches any run of characters, like the regex a bundler builds for `import(\`./x/${a}.json\`)`.
 * Greedy left-to-right matching is exact for star-only patterns and never backtracks.
 */
export const wildcardMatcher = (pattern: string, star: string) => {
  const parts = pattern.split(star);
  const first = parts[0];
  const last = parts[parts.length - 1];
  return (text: string): boolean => {
    if (parts.length === 1) return text === first;
    if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
    const end = text.length - last.length;
    let pos = first.length;
    for (let i = 1; i < parts.length - 1; i++) {
      const at = text.indexOf(parts[i], pos);
      if (at === -1 || at + parts[i].length > end) return false;
      pos = at + parts[i].length;
    }
    return true;
  };
};

/**
 * `M` module runs, `S` export used, `D` local binding used, `I` input. `T` and `Y` are `S`
 * and `D` reached only through types (`import type`): the module does not run, and packages
 * count by version.
 */
export type NodeKind = 'M' | 'S' | 'D' | 'I' | 'T' | 'Y';

export const hashOf = (data: string | Buffer) => createHash('sha256').update(data).digest('hex').slice(0, 20);

const posix = (path: string) => (sep === '/' ? path : path.split(sep).join('/'));

export const nodeId = (kind: NodeKind, file: string, name?: string) =>
  name === undefined ? `${kind}${SEP}${file}` : `${kind}${SEP}${file}${SEP}${name}`;

export const parseNodeId = (id: string) => {
  const [kind, file, name] = id.split(SEP);
  return { kind: kind as NodeKind, file, name };
};

/** A piece of code (or a whole file) that the app depends on. */
export interface LiveFragment {
  key: string;
  file: string;
  hash: string;
  /** Graph node that made this fragment live. Walk `parents` from here to explain why. */
  via: string;
}

export interface FileRecord {
  file: string;
  key: string;
  kind: ModuleInfo['kind'];
  reason?: string;
  /** The module runs: its top-level side effects count. */
  evaluated: boolean;
  /** Export names something asked for. `*` means all of them. */
  used: Set<string>;
  package?: PackageInfo;
}

export interface Unresolved {
  specifier: string;
  from: string;
  /** Only `import type` asked for it: the bundle does not depend on it. */
  type?: boolean;
}

/** Fragment ids within one module, mapped to content hashes. Same ids the graph marks live. */
export const moduleFragments = (module: ModuleInfo): Map<string, string> => {
  const out = new Map<string, string>();
  if (module.kind === 'opaque') {
    out.set('', module.hash ?? hashOf(module.content));
    return out;
  }
  for (const [name, decl] of module.decls) out.set(name, hashOf(decl.text));
  for (const [name, binding] of module.imports) out.set(`import:${name}`, hashOf(binding.text));
  for (const [name, entry] of module.exports) if (entry.text) out.set(`export:${name}`, hashOf(entry.text));
  for (const star of module.stars) out.set(`export*:${star.source}`, hashOf(star.text));
  if (module.effects.text) out.set('<module>', hashOf(module.effects.text));
  if (module.types.text) out.set('<types>', hashOf(module.types.text));
  return out;
};

export const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.pcss']);
const STYLE_RULE = /@(import|use|forward|plugin|config|reference)\b/g;
const QUOTED = /url\(\s*(['"]?)([^'"\n)]*?)\1\s*\)|(['"])([^'"\n]*)\3/y;
/** CSS Modules `composes: a from './b.css'` and `@value primary from './colors.css'`. */
const STYLE_FROM = /(?:\bcomposes\s*:|@value\s)[^;{}]{0,500}?\bfrom\s+(['"])([^'"\n]+)\1/g;
/** `@value colors: "./colors.css";`, a name for a path that `@value primary from colors` then uses. */
const STYLE_VALUE_PATH = /@value\s+[\w-]+\s*:\s*(['"])([^'"\n]+\.(?:css|scss|sass|less|pcss))\1/g;
const STYLE_URL = /\burl\(\s*(['"]?)([^'")\s]+)\1\s*\)/g;
const SCRIPT_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
const EXTERNAL_URL = /^([a-z][\w+.-]*:|\/|#)/i;

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Quoted strings in `image-set("./a.png" 1x, "./a@2x.png" 2x)`. `url()` inside it is matched separately. */
const imageSetTargets = (source: string): string[] => {
  const out: string[] = [];
  for (let at = source.indexOf('image-set('); at !== -1; at = source.indexOf('image-set(', at + 1)) {
    let depth = 0;
    let end = at + 'image-set'.length;
    for (; end < source.length && end - at < 2000; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    for (const m of source.slice(at, end).matchAll(/(['"])([^'"\n]+)\1/g)) out.push(m[2]);
  }
  return out;
};

/** The specifiers after `@import` (a comma list in Sass, `(reference)` options in Less) or `@use`. */
const ruleSpecifiers = (source: string, rule: string, from: number): string[] => {
  const out: string[] = [];
  let pos = from;
  const skip = () => {
    while (pos < source.length && /\s/.test(source[pos])) pos++;
  };
  skip();
  if (rule === 'import' && source[pos] === '(') {
    const close = source.indexOf(')', pos);
    if (close === -1 || close - pos > 200) return out;
    pos = close + 1;
    skip();
  }
  while (pos < source.length) {
    QUOTED.lastIndex = pos;
    const m = QUOTED.exec(source);
    if (!m) break;
    out.push(m[2] ?? m[4]);
    pos = QUOTED.lastIndex;
    skip();
    if (rule !== 'import' || source[pos] !== ',') break;
    pos++;
    skip();
  }
  return out;
};

/** Comments hold old `@import` lines. `//` comments only in Sass and Less, and not inside `url(https://...)`. */
const stripStyleComments = (file: string, source: string) => {
  const blockless = stripBlocks(source, '/*', '*/');
  return /\.(scss|sass|less)$/.test(file) ? blockless.replace(/(^|[\s;{}])\/\/[^\n]*/g, '$1') : blockless;
};

/**
 * Files a stylesheet pulls in: `@import`, Sass `@use`/`@forward`, Tailwind `@reference`,
 * `@plugin` and `@config`, CSS Modules `composes` and `@value`, and relative `url()` and
 * `image-set()` assets. Targets found next to the file become absolute paths (Sass partials
 * included). Package targets keep their specifier, prefixed `style:` for stylesheets.
 * `@plugin` and `@config` load JavaScript, so they resolve like imports. `missing` lists
 * asset paths that do not exist, so git mode notices when one is deleted.
 */
const styleReferences = (file: string, raw: string): { specifiers: string[]; missing: string[] } => {
  const source = stripStyleComments(file, raw);
  const out: string[] = [];
  const missing: string[] = [];
  const addStyle = (specifier: string, script: boolean) => {
    specifier = specifier.replace(/^~/, '');
    // Sass `@use "pkg:bootstrap"` loads a package stylesheet, as `@use "bootstrap"` does.
    if (specifier.startsWith('pkg:')) {
      out.push(`style:${specifier.slice(4)}`);
      return;
    }
    // `@import "/src/theme.css"`: Vite reads it from the project root.
    if (/^\/[^/]/.test(specifier)) {
      out.push(`root:${specifier}`);
      return;
    }
    if (specifier === '' || EXTERNAL_URL.test(specifier)) return;
    const local = join(dirname(file), specifier);
    const found = script ? SCRIPT_SUFFIXES.map(e => local + e).find(isFile) : findStyleFile(local);
    if (found) out.push(found);
    else out.push(script || specifier.startsWith('.') ? specifier : `style:${specifier}`);
  };
  for (const match of source.matchAll(STYLE_RULE)) {
    const rule = match[1];
    for (const specifier of ruleSpecifiers(source, rule, (match.index ?? 0) + match[0].length)) addStyle(specifier, rule === 'plugin' || rule === 'config');
  }
  for (const match of source.matchAll(STYLE_FROM)) addStyle(match[2], false);
  for (const match of source.matchAll(STYLE_VALUE_PATH)) addStyle(match[2], false);
  // Images and fonts next to the stylesheet. `url(/x.png)` points at public/, an input already.
  const assets = [...[...source.matchAll(STYLE_URL)].map(m => m[2]), ...imageSetTargets(source)];
  for (const value of assets) {
    const target = value.split(/[?#]/)[0];
    if (target === '' || EXTERNAL_URL.test(target)) continue;
    const asset = join(dirname(file), target);
    if (out.includes(asset)) continue;
    if (isFile(asset)) out.push(asset);
    // `url("@/assets/hero.png")`: bundlers resolve aliases here too. The graph tries them.
    else if (!target.startsWith('.')) out.push(`asset:${target}`);
    else if (!/\.(css|scss|sass|less)$/.test(target)) missing.push(asset);
  }
  return { specifiers: out, missing };
};

export const loadModule = (file: string, content: Buffer | string, options?: ParseOptions): { module: ModuleInfo; errors: string[] } => {
  const ext = extname(file);
  if (JS_EXTENSIONS.has(ext)) return parseModule(file, content.toString(), options);
  if (ext === '.mdx' || ext === '.md') return { module: mdxModule(content.toString()), errors: [] };
  if (COMPONENT_EXTENSIONS.has(ext)) {
    const source = content.toString();
    const parts = componentParts(file, source);
    const errors: string[] = [];
    const scripts = parts.scripts.map(s => {
      const outcome = parseModule(`${file}.script${s.ext}`, s.code, options);
      errors.push(...outcome.errors);
      return { module: outcome.module, code: s.code };
    });
    const styles = parts.styles.map(s => styleReferences(`${file}.style${s.ext}`, s.code));
    const module = componentModule(file, source, scripts, styles.flatMap(s => s.specifiers));
    module.missing = styles.flatMap(s => s.missing);
    return { module, errors };
  }
  const refs = STYLE_EXTENSIONS.has(ext) ? styleReferences(file, content.toString()) : { specifiers: [], missing: [] };
  return { module: { kind: 'opaque', reason: 'asset', content, specifiers: refs.specifiers, missing: refs.missing, jsx: false }, errors: [] };
};

/** Requests that run the target: value imports and re-exports, in source order. */
export const valueRequests = (module: ModuleInfo, modularize: Record<string, unknown>): ModuleRequest[] =>
  module.kind === 'esm' ? module.requests.filter(r => !r.type && !(r.named && modularize[r.source])) : [];

const FILES_IGNORE = ['**/node_modules/**', '**/.git/**', '**/.next/**', '**/.turbo/**', '**/.vercel/**', ...OS_FILES];

const filesUnder = (dir: string, boundary: string): string[] => {
  try {
    return safeGlob(['**/*'], { cwd: dir, ignore: FILES_IGNORE, boundary }).sort();
  } catch {
    return [];
  }
};

/**
 * Strongly connected components reachable from `start`, each one listed after every component
 * it reaches (Tarjan's algorithm, iterative). Nodes for which `done` holds are not entered.
 */
const components = (start: string, next: (node: string) => string[], done: (node: string) => boolean): string[][] => {
  const out: string[][] = [];
  if (done(start)) return out;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const work: Array<{ node: string; edges: string[]; i: number }> = [];
  const enter = (node: string) => {
    index.set(node, index.size);
    low.set(node, index.get(node) as number);
    stack.push(node);
    onStack.add(node);
    work.push({ node, edges: next(node).filter(n => !done(n)), i: 0 });
  };
  enter(start);
  while (work.length > 0) {
    const frame = work[work.length - 1];
    if (frame.i < frame.edges.length) {
      const to = frame.edges[frame.i++];
      if (!index.has(to)) enter(to);
      else if (onStack.has(to)) low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(to) as number));
      continue;
    }
    work.pop();
    const parent = work[work.length - 1];
    if (parent) low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(frame.node) as number));
    if (low.get(frame.node) !== index.get(frame.node)) continue;
    const component: string[] = [];
    let node: string;
    do {
      node = stack.pop() as string;
      onStack.delete(node);
      component.push(node);
    } while (node !== frame.node);
    out.push(component);
  }
  return out;
};

/**
 * Parsed modules shared by the graphs of one run. The apps of a workspace reach the same packages,
 * and parsing is most of a run. An entry holds the module and the warning its file gave. Valid
 * only while no file changes, so make a new one per run.
 */
export type ModuleCache = Map<string, { module: ModuleInfo; warning?: string }>;

export const fragmentKey = (fileKey: string, fragment: string) => (fragment === '' ? fileKey : `${fileKey}#${fragment}`);

export class UsageGraph {
  readonly project: Project;
  readonly resolver: Resolver;
  readonly files = new Map<string, FileRecord>();
  readonly live = new Map<string, LiveFragment>();
  /** Graph node -> the node that reached it first (BFS, so chains are shortest). */
  readonly parents = new Map<string, string | null>();
  /** Graph node -> every node that reached it. `entriesReaching` walks it backwards. */
  readonly reachedFrom = new Map<string, Set<string>>();
  /** Live fragment key -> every node that made it live. */
  readonly fragmentVias = new Map<string, Set<string>>();
  readonly unresolved: Unresolved[] = [];
  private unresolvedByKey = new Map<string, Unresolved>();
  readonly warnings: string[] = [];
  /** file -> imported file -> names. */
  readonly edges = new Map<string, Map<string, Set<string>>>();
  /** npm package name -> names imported from project code. */
  readonly packageImports = new Map<string, Set<string>>();
  /**
   * Paths whose deletion git mode must count: directories read whole (`trees`), computed import
   * patterns (`contexts`), named paths that do not exist (`missing`), and `shadowed` stems, alias
   * targets that lost to an earlier one, so a deleted earlier one hands the import to them.
   */
  readonly patterns = {
    trees: [] as string[],
    contexts: [] as Array<(path: string) => boolean>,
    missing: new Set<string>(),
    shadowed: new Set<string>(),
  };
  /** Tailwind root stylesheet -> what the Tailwind run reported for it. */
  readonly tailwind = new Map<string, TailwindResult>();
  /** Tailwind root -> the stylesheets in its `@import` closure that hold Tailwind directives. */
  readonly tailwindMembers: Record<string, string[]> = {};
  /** Files imported with `?raw`: their exact text ends up in the bundle. */
  readonly rawFiles = new Set<string>();
  /** Environment variables project code reads by name -> the node that read one first. */
  readonly env = new Map<string, Set<string>>();
  /** Variables the framework inlines whatever their name, such as SvelteKit's `$env/static/private`. */
  private inlinedEnv = new Set<string>();
  readonly parseOptions: ParseOptions;
  unresolvedInPackages = 0;

  private modules = new Map<string, ModuleInfo>();
  /** Binding node ids a live usage asks for but the module does not declare -> the node that asked. */
  private missingRefs = new Map<string, string>();
  private keys = new Map<string, string>();
  private queue: string[] = [];
  private exportNameCache = new Map<string, Set<string>>();
  private effectCache = new Map<string, boolean>();
  private collisions = new Map<string, Map<string, string>>();
  private seenWarnings = new Set<string>();
  private nodeByFile?: Map<string, string>;

  private cache?: ModuleCache;
  private cachePrefix: string;

  constructor(project: Project, resolver?: Resolver, cache?: ModuleCache) {
    this.project = project;
    this.parseOptions = project.parseOptions;
    this.cache = cache;
    // The same file parses differently under another app's JSX or `verbatimModuleSyntax` settings.
    this.cachePrefix = JSON.stringify(project.parseOptions) + SEP;
    this.resolver =
      resolver ??
      new Resolver({
        conditions: project.config.conditions,
        reactServer: project.framework === 'next',
        edge: [...(project.framework === 'next' ? (['edge-light'] as const) : []), ...(project.workers ? (['workerd'] as const) : [])],
        tsconfig: project.tsconfig,
        modularizeImports: project.config.modularizeImports,
        alias: project.aliases,
        platforms: project.framework === 'react-native' ? ['ios', 'android', 'native', 'web'] : undefined,
      });
  }

  build(): this {
    for (const input of this.project.inputs) this.markInput(input);
    for (const name of this.project.packages) this.markPackageVersion(name);
    for (const entry of this.project.entries) this.enqueue(nodeId('S', entry, '*'), null);
    this.drain();
    this.useClientReferences();
    this.useTailwind();
    this.drain();
    this.useWorkspaceManifests();
    this.useEnv();
    for (const stem of this.resolver.variantStems) this.patterns.shadowed.add(stem);
    for (const u of this.unresolved) {
      if (!this.isProjectImport(u)) continue;
      this.warn(
        `${this.fileKey(u.from)}: cannot resolve "${u.specifier}", so changes behind it are invisible ` +
          '(a bundler alias byakugan does not read, or a plugin\'s virtual module: list it under "virtual" in byakugan.json)'
      );
    }
    return this;
  }

  /**
   * Strict mode only. Next.js ships a `'use client'` module whole when a server module imports it:
   * the client loads the module by id and picks the export by name, so the bundler keeps every
   * export. An unused export next to a used one then changes the client chunk, though nothing
   * runs it, which is why behavior mode leaves it out. Between two client modules the bundler
   * tree-shakes as usual, so only imports from the server side count here. Server modules are the
   * entries and what they import, up to the first `'use client'` file.
   */
  private useClientReferences() {
    if (this.project.framework !== 'next' || this.project.config.mode !== 'strict') return;
    const isClient = (file: string) => {
      const module = this.modules.get(file);
      return module?.kind === 'esm' && module.directives.includes('use client');
    };
    // Marking a module whole can reach new server modules, so repeat until a pass adds nothing.
    for (let before = -1; before !== this.queue.length; ) {
      before = this.queue.length;
      const server = new Set(this.project.entries.filter(f => !isClient(f)));
      const walk = [...server];
      while (walk.length > 0) {
        const from = walk.pop() as string;
        for (const to of this.edges.get(from)?.keys() ?? []) {
          if (isClient(to)) {
            const run = nodeId('M', from);
            this.enqueue(nodeId('S', to, '*'), this.parents.has(run) ? run : nodeId('S', from, '*'));
          } else if (!server.has(to)) {
            server.add(to);
            walk.push(to);
          }
        }
      }
      this.drain();
    }
  }

  /** Name globs of the environment variables whose values count: the ones the framework inlines, plus `env`. */
  envPatterns(): string[] {
    const framework = this.project.framework;
    const inlined =
      framework === 'next'
        ? ['NEXT_PUBLIC_*']
        : framework === 'vite' || framework === 'react-router'
          ? ['VITE_*']
          : framework === 'sveltekit' || framework === 'astro'
            ? ['PUBLIC_*']
            : framework === 'react-native'
              ? ['EXPO_PUBLIC_*']
              : [];
    return [...inlined, ...(this.project.config.env ?? [])];
  }

  /** Values of the environment variables live code reads, when `envPatterns` names them. */
  private useEnv() {
    const matchers = this.envPatterns().map(p => wildcardMatcher(p, '*'));
    const counts = (name: string) => this.inlinedEnv.has(name) || matchers.some(match => match(name));
    // `import.meta.env` read whole holds every exposed variable that is set.
    const whole = this.env.get('*');
    if (whole) for (const name of Object.keys(process.env)) if (counts(name)) for (const via of whole) this.readEnv(name, via);
    for (const [name, vias] of [...this.env].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (name === '*' || !counts(name)) continue;
      const value = process.env[name];
      for (const via of vias) this.markKey(`env:${name}`, '', hashOf(value === undefined ? '\0unset' : `=${value}`), via);
    }
  }

  private readEnv(name: string, via: string) {
    const vias = this.env.get(name);
    if (vias) vias.add(via);
    else this.env.set(name, new Set([via]));
  }

  /**
   * package.json and tsconfig of every workspace package the app reaches: `exports`, `sideEffects`
   * and `paths` there decide which files the app loads.
   */
  private useWorkspaceManifests() {
    const dirs = new Set<string>();
    for (const record of this.files.values()) {
      if (isInNodeModules(record.file)) continue;
      const pkg = this.resolver.packageOf(record.file);
      if (pkg && pkg.dir !== this.project.dir && this.inside(pkg.dir)) dirs.add(pkg.dir);
    }
    for (const dir of [...dirs].sort()) {
      for (const file of [join(dir, 'package.json'), ...tsconfigFiles(dir, this.project.repo)]) if (!this.live.has(this.fileKey(file))) this.markInput(file);
    }
  }

  private virtual?: (specifier: string) => boolean;

  /** A specifier a bundler plugin provides (`"virtual"` in byakugan.json), such as `~icons/mdi/home`. */
  isVirtual(specifier: string): boolean {
    this.virtual ??= globMatcher(this.project.config.virtual ?? [], { dot: true });
    return this.virtual(specifier);
  }

  /** Next.js aliases these to its own compiled copies, so installing them is optional. */
  private nextProvides(specifier: string): boolean {
    return this.project.framework === 'next' && /^(server-only|client-only|styled-jsx)(\/|$)/.test(specifier);
  }

  /**
   * An unresolved import of code in this repository: a path, an alias, a workspace package, a
   * `baseUrl` directory, or a bare name no package.json declares (most likely a bundler alias).
   * A declared npm package that is not installed is not one: its code arrives through the lockfile.
   */
  isProjectImport(u: Unresolved): boolean {
    const s = u.specifier;
    if (isInNodeModules(u.from) || this.isVirtual(s)) return false;
    if (/^[./#~$]/.test(s) || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/.*)?$/i.test(s)) return true;
    // A tsconfig alias wins over Next.js's own copy, so a local `server-only` shim fails closed.
    if (this.project.pathTargets(s).length > 0) return true;
    if (this.nextProvides(s)) return false;
    const name = packageNameOf(s);
    for (let dir = dirname(u.from); ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name);
      let link;
      try {
        link = lstatSync(candidate);
      } catch {}
      if (link) {
        if (existsSync(join(candidate, 'package.json'))) {
          try {
            return !isInNodeModules(realpathSync(candidate) + sep);
          } catch {
            return false;
          }
        }
        // A link to a workspace package that is gone.
        if (link.isSymbolicLink()) return true;
      }
      if (dirname(dir) === dir) break;
    }
    const spec = this.declaredSpec(name, u.from);
    return spec === undefined || /^(workspace|file|link|portal):/.test(spec);
  }

  private manifests = new Map<string, Record<string, unknown> | null>();

  /** The version range a package.json between `from` and the repository root gives `name`. */
  private declaredSpec(name: string, from: string): string | undefined {
    const top = this.project.repo;
    for (let dir = dirname(from); dir === top || dir.startsWith(top + sep); dir = dirname(dir)) {
      let manifest = this.manifests.get(dir);
      if (manifest === undefined) {
        const text = readText(join(dir, 'package.json'));
        let parsed: unknown;
        try {
          parsed = text === undefined ? null : parseJsonc(text);
        } catch {}
        manifest = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
        this.manifests.set(dir, manifest);
      }
      for (const field of DEPENDENCY_FIELDS) {
        const spec = (manifest?.[field] as Record<string, unknown> | undefined)?.[name];
        if (typeof spec === 'string') return spec;
      }
      if (dirname(dir) === dir) break;
    }
  }

  private insideCache = new Map<string, boolean>();

  /**
   * Inside the repository, following symlinks. An installed package counts wherever its real path
   * is (a pnpm store, a linked checkout) as long as that is a node_modules directory too, so a
   * committed `vendor/node_modules/x -> /etc` does not.
   */
  private inside(path: string): boolean {
    const cached = this.insideCache.get(path);
    if (cached !== undefined) return cached;
    const real = this.realPath(path);
    const repo = this.project.repo;
    const result = real === repo || real.startsWith(repo + sep) || (isInNodeModules(path) && isInNodeModules(real));
    this.insideCache.set(path, result);
    return result;
  }

  private realDirs = new Map<string, string>();

  /** `realpathSync`, with the directory part cached: one lstat for a file that is not a link. */
  private realPath(path: string): string {
    // `src/cfg/` with its slash would make lstat follow the link.
    path = resolve(path);
    let link = false;
    try {
      link = lstatSync(path).isSymbolicLink();
    } catch {}
    if (link) {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    }
    const dir = dirname(path);
    let real = this.realDirs.get(dir);
    if (real === undefined) {
      try {
        real = realpathSync(dir);
      } catch {
        real = dir;
      }
      this.realDirs.set(dir, real);
    }
    return dir === real ? path : join(real, basename(path));
  }

  private drained = 0;

  private drain() {
    for (; this.drained < this.queue.length; this.drained++) {
      const id = this.queue[this.drained];
      const { kind, file, name } = parseNodeId(id);
      if (kind === 'M') this.evaluate(file, id);
      else if (kind === 'S') this.useExport(file, name, id);
      else if (kind === 'D') this.useBinding(file, name, id);
      else if (kind === 'T') this.useTypeExport(file, name, id);
      else if (kind === 'Y') this.useTypeBinding(file, name, id);
    }
  }

  /**
   * Tailwind writes CSS for class names found in every file it scans, imported or not.
   * Its output for each root stylesheet becomes a fragment of its own, so a class added
   * to an unimported file counts only when it changes the generated CSS.
   */
  private useTailwind() {
    const isStyle = (file: string) => STYLE_EXTENSIONS.has(extname(file)) && this.modules.get(file)?.kind === 'opaque';
    const styles = [...this.files.values()].filter(r => r.evaluated && isStyle(r.file)).map(r => r.file);
    const isRoot = (file: string) => {
      const module = this.modules.get(file);
      return module?.kind === 'opaque' && isTailwindRoot(module.content.toString());
    };
    // The bundler compiles each stylesheet code imports, with everything it `@import`s inlined. So the
    // Tailwind root is that stylesheet, even when `@import "tailwindcss"` sits in a file it imports.
    const fromCode = new Set(this.project.entries);
    for (const [from, targets] of this.edges) if (!isStyle(from)) for (const to of targets.keys()) fromCode.add(to);
    const roots: string[] = [];
    const members = this.tailwindMembers;
    const covered = new Set<string>();
    // Tailwind compiles plain CSS only. A Sass file runs through Sass first, which inlines its
    // partials, so it is a root like a .css file. Less is not compiled, so each Less file stands alone.
    for (const top of styles.filter(f => fromCode.has(f) && ['.css', '.scss', '.sass'].includes(extname(f))).sort()) {
      const closure = new Set([top]);
      const queue = [top];
      while (queue.length > 0) {
        const file = queue.pop() as string;
        for (const to of this.edges.get(file)?.keys() ?? []) {
          if (isStyle(to) && !closure.has(to)) {
            closure.add(to);
            queue.push(to);
          }
        }
      }
      // Sass inlines Sass partials, and leaves `@import "./tw.css"` to the bundler, which runs
      // PostCSS on tw.css by itself. So a .css file under a Sass root stays a root of its own.
      const sass = extname(top) !== '.css';
      const own = [...closure].filter(f => !sass || extname(f) !== '.css');
      const found = own.filter(isRoot).sort();
      if (found.length === 0) continue;
      roots.push(top);
      members[top] = found;
      for (const f of own) covered.add(f);
    }
    for (const file of styles.sort()) {
      if (covered.has(file) || isInNodeModules(file) || !isRoot(file)) continue;
      roots.push(file);
      members[file] = [file];
    }
    if (roots.length === 0) return;
    this.markPackageVersion('tailwindcss');
    for (const result of runTailwind(this.tailwindRequest(roots))) {
      this.tailwind.set(result.file, result);
      const via = nodeId('M', result.file);
      if (result.hash !== undefined) {
        this.markLive(result.file, '<tailwind>', result.hash, via);
        for (const dep of result.deps) if (isFile(dep)) this.enqueue(nodeId('S', dep, '*'), via);
        continue;
      }
      this.warn(
        `${this.fileKey(result.file)}: could not run Tailwind (${result.error}), so every file in the repository it may scan is hashed whole`
      );
      for (const file of tailwindFallbackFiles(this.project.repo)) if (this.inside(file)) this.markInput(file);
      // Git mode matches deleted files against this: deleting any file Tailwind might scan counts.
      if (!this.patterns.trees.includes(this.project.repo)) this.patterns.trees.push(this.project.repo);
    }
  }

  /** What to ask the Tailwind worker for `roots`, the same way for both sides of a comparison. */
  tailwindRequest(roots: string[], overrides?: Record<string, string | null>): TailwindRequest {
    const { framework, dir } = this.project;
    // Vite runs postcss-import before the project's PostCSS plugins, so Tailwind sees `@import`s inlined.
    const inlineImports = framework === 'vite' || framework === 'react-router';
    return { dir, roots, members: this.tailwindMembers, inlineImports, ...(overrides ? { overrides } : {}) };
  }

  /** Stable key for a file: root-relative path, or `npm:<package>/<path>` inside node_modules. */
  fileKey(file: string): string {
    let key = this.keys.get(file);
    if (key !== undefined) return key;
    const pkg = isInNodeModules(file) ? this.resolver.packageOf(file) : undefined;
    key = pkg ? `npm:${pkg.name}/${posix(relative(pkg.dir, file))}` : posix(relative(this.project.root, file));
    this.keys.set(file, key);
    return key;
  }

  module(file: string): ModuleInfo | undefined {
    return this.modules.get(file);
  }

  private copies?: Map<string, string>;

  /**
   * The node_modules copy of a workspace file: yarn `file:` dependencies and pnpm `injected`
   * ones install a copy instead of a link, so the graph reads the copy.
   */
  installedCopy(file: string): string | undefined {
    const pkg = this.resolver.packageOf(file);
    if (!pkg) return;
    if (!this.copies) {
      this.copies = new Map();
      for (const f of this.files.keys()) if (isInNodeModules(f)) this.copies.set(this.fileKey(f), f);
    }
    return this.copies.get(`npm:${pkg.name}/${posix(relative(pkg.dir, file))}`);
  }

  isLive(key: string) {
    return this.live.has(key);
  }

  fingerprint(): string {
    const lines: string[] = [];
    for (const f of this.live.values()) lines.push(`${f.key}${SEP}${f.hash}`);
    lines.sort();
    return createHash('sha256').update(lines.join('\n')).digest('hex');
  }

  /** Node ids from an entry (or input) down to `id`. */
  chain(id: string): string[] {
    const out: string[] = [];
    let current: string | null | undefined = id;
    // `parents` is a tree (a node gets one parent, once), so the walk ends; the bound is a backstop.
    while (current && out.length <= this.parents.size) {
      out.push(current);
      current = this.parents.get(current);
    }
    return out.reverse();
  }

  private load(file: string): ModuleInfo {
    const cached = this.modules.get(file);
    if (cached) return cached;
    let module: ModuleInfo;
    const outside = !this.inside(file);
    const shared = outside ? undefined : this.cache?.get(this.cachePrefix + file);
    const read = outside || shared ? undefined : readRegular(file, JS_EXTENSIONS.has(extname(file)) || STYLE_EXTENSIONS.has(extname(file)) || COMPONENT_EXTENSIONS.has(extname(file)));
    if (outside) {
      module = { kind: 'opaque', reason: 'asset', content: '', specifiers: [], jsx: false };
    } else if (shared) {
      module = shared.module;
      if (shared.warning) this.warn(`${this.fileKey(file)}: ${shared.warning}`);
    } else if (read === undefined) {
      // A link to a directory the crawl lists already: hashed by its target, like an input.
      const link = linkedDirectory(file);
      module = { kind: 'opaque', reason: 'asset', content: link ?? '', specifiers: [], jsx: false };
      if (link === undefined) this.warn(`${this.fileKey(file)}: cannot read it (missing, or not a regular file)`);
    } else if ('hash' in read) {
      module = { kind: 'opaque', reason: 'asset', content: '', hash: read.hash, specifiers: [], jsx: false };
    } else {
      let warning: string | undefined;
      try {
        const outcome = loadModule(file, read.content, this.parseOptions);
        module = outcome.module;
        if (outcome.errors.length > 0 && !isInNodeModules(file)) warning = `parse error, hashing the whole file (${outcome.errors[0]})`;
      } catch (error) {
        // Never hash an empty string for a file that has content: edits to it would go unseen.
        module = { kind: 'opaque', reason: 'parse-error', content: read.content, specifiers: [], jsx: false };
        warning = `cannot analyze, hashing the whole file (${(error as Error).message})`;
      }
      if (warning) this.warn(`${this.fileKey(file)}: ${warning}`);
      this.cache?.set(this.cachePrefix + file, { module, warning });
    }
    this.modules.set(file, module);
    if (!isInNodeModules(file)) this.checkBuildOutput(file);
    this.files.set(file, {
      file,
      key: this.fileKey(file),
      kind: module.kind,
      reason: module.kind === 'opaque' ? module.reason : undefined,
      evaluated: false,
      used: new Set(),
      package: isInNodeModules(file) ? this.resolver.packageOf(file) : undefined,
    });
    return module;
  }

  /** Workspace packages whose `exports` point at `dist/` hide source changes from git mode. */
  private checkBuildOutput(file: string) {
    const pkg = this.resolver.packageOf(file);
    if (!pkg || pkg.dir === this.project.dir) return;
    const path = posix(relative(pkg.dir, file));
    if (!/^(dist|build|out)\//.test(path)) return;
    this.warn(
      `${pkg.name} resolves to build output (${this.fileKey(file)}), so changes to its source are invisible. ` +
        'Point its exports at the source, e.g. a "source" export condition plus "conditions": ["source"] in byakugan.json.'
    );
  }

  private enqueue(id: string, via: string | null) {
    if (via !== null) {
      const from = this.reachedFrom.get(id);
      if (from) from.add(via);
      else this.reachedFrom.set(id, new Set([via]));
    }
    if (this.parents.has(id)) return;
    const { file } = parseNodeId(id);
    if (!this.inside(file)) {
      this.warn(`${this.fileKey(file)}: outside the repository, so it is not read`);
      return;
    }
    this.parents.set(id, via);
    this.queue.push(id);
  }

  private warn(message: string) {
    if (this.seenWarnings.has(message)) return;
    this.seenWarnings.add(message);
    this.warnings.push(message);
  }

  private markKey(key: string, file: string, hash: string, via: string) {
    const vias = this.fragmentVias.get(key);
    if (vias) vias.add(via);
    else this.fragmentVias.set(key, new Set([via]));
    const existing = this.live.get(key);
    if (!existing) {
      this.live.set(key, { key, file, hash, via });
      return;
    }
    if (existing.file === file) return;
    // Two installed copies of one package file (nested versions) share a key. Hash them together.
    let copies = this.collisions.get(key);
    if (!copies) {
      copies = new Map([[existing.file, existing.hash]]);
      this.collisions.set(key, copies);
    }
    if (copies.has(file)) return;
    copies.set(file, hash);
    existing.hash = hashOf([...copies.values()].sort().join(','));
  }

  private markLive(file: string, fragment: string, content: string | Buffer, via: string) {
    this.markKey(fragmentKey(this.fileKey(file), fragment), file, hashOf(content), via);
  }

  private markOpaque(file: string, module: { content: string | Buffer; hash?: string }, via: string) {
    this.markKey(this.fileKey(file), file, module.hash ?? hashOf(module.content), via);
  }

  private markInput(file: string) {
    if (!this.inside(file)) {
      this.warn(`${this.fileKey(file)}: points outside the repository, so it is not read`);
      return;
    }
    // `public/img2 -> img`, a directory the crawl lists under its own path: hashed like the blob git stores, its target.
    let read: ReturnType<typeof readRegular> = readRegular(file);
    const link = read ? undefined : linkedDirectory(file);
    if (link !== undefined) read = { content: Buffer.from(link) };
    if (!read) return;
    const via = nodeId('I', file);
    this.parents.set(via, null);
    const hash = 'hash' in read ? read.hash : inputHash(file, read.content, this.project.lockfile !== undefined);
    this.markKey(this.fileKey(file), file, hash, via);
  }

  private installedPackage(name: string): { version: string; dir: string } | undefined {
    let dir = this.project.dir;
    while (true) {
      const pkg = join(dir, 'node_modules', name);
      const manifest = join(pkg, 'package.json');
      if (existsSync(manifest)) {
        try {
          return { version: String((JSON.parse(readText(manifest) ?? '') as { version?: unknown }).version), dir: pkg };
        } catch {
          return;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) return;
      dir = parent;
    }
  }

  /** Tools that read the app without being imported (framework, compiler, CSS) are tracked by version. */
  private markPackageVersion(name: string) {
    const via = nodeId('I', `npm:${name}`);
    if (!this.parents.has(via)) this.parents.set(via, null);
    const declared = DEPENDENCY_FIELDS.map(f => (this.project.manifest?.[f] as Record<string, string> | undefined)?.[name]).find(Boolean);
    const version = this.installedPackage(name)?.version ?? `not installed (${declared ?? 'undeclared'})`;
    this.markKey(`npm:${name}#<version>`, '', hashOf(version), via);
  }

  /** A package reached through types. Two installed copies (nested versions) hash together. */
  private markPackageTypes(file: string, via: string) {
    const pkg = this.resolver.packageOf(file);
    if (!pkg) return;
    this.markKey(`npm:${pkg.name}#<types>`, pkg.dir, hashOf(pkg.version), via);
    this.markTypesPackage(pkg.name, via);
  }

  /** `@types/mdast` for `mdast`, `@types/babel__core` for `@babel/core`. False when it is not installed. */
  private markTypesPackage(name: string, via: string): boolean {
    const typesName = `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;
    const types = this.installedPackage(typesName);
    if (types) this.markKey(`npm:${typesName}#<types>`, types.dir, hashOf(types.version), via);
    return types !== undefined;
  }

  /** `import type { Paragraph } from 'mdast'`: no package `mdast` exists, and the types come from `@types/mdast`. */
  private useTypesOnlyPackage(specifier: string, from: string, via: string): boolean {
    if (isInNodeModules(from) || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/.*)?$/i.test(specifier)) return false;
    if (this.project.pathTargets(specifier).length > 0 || this.resolver.resolve(specifier, from).length > 0) return false;
    return this.markTypesPackage(packageNameOf(specifier), via);
  }

  private resolveOrRecord(specifier: string, from: string, type = false): string[] {
    const targets = this.resolver.resolve(specifier, from);
    // `@/x` with paths ['./src/*', './gen/*']: deleting src/x.ts makes it gen/x.ts.
    if (targets.length > 0 && !isInNodeModules(from) && !specifier.startsWith('.')) {
      const bases = this.project.pathTargets(specifier);
      const wins = (base: string) => targets.some(t => t === base || t.slice(0, t.length - extname(t).length) === base || dirname(t) === base);
      const winner = bases.findIndex(wins);
      for (const base of winner === -1 ? bases : bases.slice(0, winner)) this.patterns.shadowed.add(base);
    }
    if (targets.length === 0 && !this.resolver.isBuiltin(specifier)) {
      const key = `${from}${SEP}${specifier}`;
      const seen = this.unresolvedByKey.get(key);
      if (seen) {
        if (!type) seen.type = undefined;
      } else if (isInNodeModules(from)) {
        this.unresolvedByKey.set(key, { specifier, from });
        this.unresolvedInPackages++;
      } else {
        const record: Unresolved = type ? { specifier, from, type } : { specifier, from };
        this.unresolvedByKey.set(key, record);
        this.unresolved.push(record);
      }
    }
    return targets;
  }

  private recordEdge(from: string, to: string, name: string) {
    let targets = this.edges.get(from);
    if (!targets) {
      targets = new Map();
      this.edges.set(from, targets);
    }
    const names = targets.get(to);
    if (names) names.add(name);
    else targets.set(to, new Set([name]));
    if (!isInNodeModules(from) && isInNodeModules(to)) {
      const pkg = this.resolver.packageOf(to);
      if (!pkg) return;
      const imported = this.packageImports.get(pkg.name);
      if (imported) imported.add(name);
      else this.packageImports.set(pkg.name, new Set([name]));
    }
  }

  private useImport(from: string, specifier: string, imported: string, type: boolean, via: string) {
    if (this.resolver.isBuiltin(specifier)) return;
    // SvelteKit inlines `import { PUBLIC_API } from '$env/static/public'` (and `/private`) at build time.
    if (this.project.framework === 'sveltekit' && /^\$env\/static\/(public|private)$/.test(specifier)) {
      if (!type && imported !== '*' && imported !== 'default' && !isInNodeModules(from)) {
        this.readEnv(imported, via);
        this.inlinedEnv.add(imported);
      }
      return;
    }
    const query = specifier.indexOf('?');
    if (query > 0 && !type) {
      // Vite `?url`, `?raw`, `?inline`, `?worker`: the file is used whole, whatever it exports.
      // `?raw` inlines the text, `?url` emits the file as it is: either way its exact bytes ship.
      const raw = /(^|&)(raw|url)(&|=|$)/.test(specifier.slice(query + 1));
      for (const target of this.resolveOrRecord(specifier.slice(0, query), from)) {
        this.recordEdge(from, target, '*');
        this.enqueue(nodeId('S', target, '*'), via);
        if (raw && JS_EXTENSIONS.has(extname(target))) {
          // Read once; a second importer still joins the fragment's vias, for `--each`.
          if (!this.rawFiles.has(target)) {
            this.rawFiles.add(target);
            const read = readRegular(target, true);
            if (read && 'content' in read) this.markLive(target, '<raw>', read.content, via);
          } else this.fragmentVias.get(fragmentKey(this.fileKey(target), '<raw>'))?.add(via);
        }
      }
      return;
    }
    const modular = this.resolver.modularized(specifier, imported);
    let targets = modular ? this.resolver.resolve(modular, from) : [];
    let name = 'default';
    if (targets.length === 0) {
      if (type && this.useTypesOnlyPackage(specifier, from, via)) return;
      targets = this.resolveOrRecord(specifier, from, type);
      name = imported;
    }
    for (const target of targets) {
      if (type && isInNodeModules(target)) {
        this.markPackageTypes(target, via);
        continue;
      }
      this.recordEdge(from, target, imported);
      this.enqueue(nodeId(type ? 'T' : 'S', target, name), via);
    }
  }

  /** A package stylesheet: `@import "tw-animate-css"`, `@use "bootstrap/scss/grid"`. */
  private useStyle(from: string, specifier: string, via: string) {
    const found = this.resolver.resolveStyle(specifier, from);
    const local = found.file ?? (isInNodeModules(from) ? undefined : this.styleFallback(specifier));
    if (local) {
      this.recordEdge(from, local, '*');
      this.enqueue(nodeId('S', local, '*'), via);
    } else if (found.package) {
      const version = this.installedPackage(found.package)?.version ?? 'not installed';
      this.markKey(`npm:${found.package}#<version>`, '', hashOf(version), via);
    } else this.resolveOrRecord(specifier, from);
  }

  /** `@use '@/styles/variables'` through tsconfig `paths`, or `@use 'abstracts/colors'` through Sass load paths. */
  private styleFallback(specifier: string): string | undefined {
    const bases = [...this.project.aliasTargets(specifier), ...this.project.styleLoadPaths.map(dir => join(dir, specifier))];
    for (const base of bases) {
      const file = findStyleFile(base);
      if (file) return file;
    }
  }

  /** `url("@/assets/hero.png")`: a stylesheet asset behind a tsconfig alias. */
  private useAsset(from: string, specifier: string, via: string) {
    if (isInNodeModules(from)) return;
    const target = specifier.split(/[?#]/)[0];
    const candidates = this.project.aliasTargets(target);
    const index = candidates.findIndex(isFile);
    // Earlier targets that do not exist would win again if they came back.
    for (const t of index === -1 ? candidates : candidates.slice(0, index)) this.patterns.missing.add(t);
    if (index !== -1) this.useFile(from, candidates[index], via);
    else {
      this.patterns.missing.add(join(dirname(from), target));
      // An alias no tsconfig path covers, such as a Vite `resolve.alias`: fails closed, as in `@import`.
      if (candidates.length === 0) this.resolveOrRecord(target, from);
    }
  }

  /** `@import "/src/theme.css"`, read from the project root. A missing file is recorded, in case git mode sees it deleted. */
  private useRootStyle(from: string, specifier: string, via: string) {
    const base = join(this.project.dir, specifier);
    const found = findStyleFile(base);
    if (found) this.useFile(from, found, via);
    else for (const candidate of styleCandidates(base)) this.patterns.missing.add(candidate);
  }

  /** Sass `additionalData: '@use "@/styles/vars" as *;'` puts these rules at the top of every stylesheet. */
  private useStyleGlobal(from: string, specifier: string, via: string) {
    specifier = specifier.replace(/^~/, '');
    if (specifier === '' || EXTERNAL_URL.test(specifier)) return;
    if (specifier.startsWith('.')) {
      const local = findStyleFile(join(dirname(from), specifier));
      if (local) this.useFile(from, local, via);
      return;
    }
    this.useStyle(from, specifier, via);
  }

  /** `import(\`./messages/${locale}.json\`)`: bundlers include every file the pattern can match. */
  private useContext(from: string, pattern: string, via: string) {
    const external = isInNodeModules(from);
    const star = pattern.indexOf('*');
    const slash = pattern.lastIndexOf('/', star);
    if (star === -1) return;
    if (!/^\.\.?\//.test(pattern) || slash < 0) {
      if (!external) {
        const what = pattern === '*' ? 'an import with a computed specifier' : `import(\`${pattern.replace(/\*/g, '${…}')}\`)`;
        this.warn(`${this.fileKey(from)}: cannot follow ${what}; list its targets in "entry" or "inputs"`);
      }
      return;
    }
    const dir = resolve(dirname(from), pattern.slice(0, slash));
    const scope = external ? this.resolver.packageOf(from)?.dir : this.project.repo;
    if (!scope || !(dir === scope || dir.startsWith(scope + sep))) {
      if (!external) this.warn(`${this.fileKey(from)}: import(\`${pattern.replace(/\*/g, '${…}')}\`) points outside the repository, so it is not followed`);
      return;
    }
    // 2,000 siblings that each import() the others match the same files, so only the first
    // importer crawls and records edges. The second one adds the first, which skipped itself.
    const key = posix(resolve(dirname(from), pattern));
    const seen = this.contextsSeen.get(key);
    if (seen) {
      if (!seen.done && seen.first !== from) {
        seen.done = true;
        if (seen.matches(posix(seen.first))) this.useFile(from, seen.first, via);
      }
      return;
    }
    const matches = wildcardMatcher(posix(resolve(dirname(from), pattern.replace(/\*/g, SEP))), SEP);
    this.contextsSeen.set(key, { first: from, done: false, matches });
    this.patterns.contexts.push(matches);
    for (const file of filesUnder(dir, this.project.repo)) {
      if (file !== from && matches(posix(file))) this.useFile(from, file, via);
    }
  }

  private contextsSeen = new Map<string, { first: string; done: boolean; matches: (path: string) => boolean }>();

  /** Paths in code: `localFont({ src: './a.woff2' })`, `new URL(x, import.meta.url)`, `join(process.cwd(), ...)`. */
  private usePath(from: string, entry: string, via: string) {
    const [kind, path] = entry.split(SEP) as [PathKind, string];
    const external = isInNodeModules(from);
    if (kind === 'glob') return this.useGlob(from, path.split(GLOB_SEPARATOR), via);
    if (external && kind !== 'file') return;
    if (kind === 'alias') return this.useAliasPath(from, path, via);
    const tree = kind === 'file-tree' || kind === 'cwd-tree';
    const bases = kind === 'rel' ? [dirname(from), this.project.dir] : kind.startsWith('cwd') ? [this.project.dir] : [dirname(from)];
    for (const base of bases) {
      const target = resolve(base, path);
      if (!this.inside(target)) {
        if (!external) this.warn(`${this.fileKey(from)}: refers to ${path}, outside the repository, so it is not read`);
        return;
      }
      let stat;
      try {
        stat = statSync(target);
      } catch {
        continue;
      }
      if (stat.isFile() && !tree) return this.useFile(from, target, via);
      // A static `join(__dirname, 'src')` is usually an alias or a base path, not something the code reads.
      if (!stat.isDirectory() || !(tree || kind === 'cwd')) return;
      if (this.project.dir.startsWith(target)) {
        this.warn(`${this.fileKey(from)}: reads files from the whole project directory; list the ones it needs in "inputs"`);
        return;
      }
      this.patterns.trees.push(target);
      for (const file of filesUnder(target, this.project.repo)) this.useFile(from, file, via);
      return;
    }
    if (!external) for (const base of bases) this.patterns.missing.add(resolve(base, path));
  }

  /** `'~/assets/main.css'`: resolved like an import, recorded as missing when no alias target has it. */
  private useAliasPath(from: string, path: string, via: string) {
    const found = this.resolver.resolve(path, from).filter(t => !isInNodeModules(t));
    if (found.length > 0) {
      for (const target of found) if (this.inside(target)) this.useFile(from, target, via);
      return;
    }
    const slash = path.indexOf('/');
    const targets = [...(this.project.aliases[path.slice(0, slash)] ?? []).map(d => resolve(d, path.slice(slash + 1))), ...this.project.pathTargets(path)];
    for (const target of targets) this.patterns.missing.add(target);
  }

  /** Vite `import.meta.glob`. A leading `/` is the project root, as in Vite; `!` excludes. */
  private useGlob(from: string, patterns: string[], via: string) {
    const positive = patterns.filter(p => !p.startsWith('!'));
    const base = (p: string) => (p.startsWith('/') ? this.project.dir : /^\.\.?\//.test(p) ? dirname(from) : undefined);
    if (positive.length === 0 || positive.some(p => base(p) === undefined)) {
      if (!isInNodeModules(from)) {
        this.warn(`${this.fileKey(from)}: cannot follow import.meta.glob(${patterns.join(', ')}); list its targets in "entry"`);
      }
      return;
    }
    const local = (p: string) => p.replace(/^\//, '').replace(/^\.\//, '');
    const files = new Set<string>();
    for (const pattern of positive) {
      const cwd = base(pattern) as string;
      const ignore = patterns.filter(p => p.startsWith('!') && base(p.slice(1)) === cwd).map(p => `!${local(p.slice(1))}`);
      const absolute = resolve(cwd, local(pattern));
      if (!this.inside(absolute.split(/[*?{[]/)[0])) {
        this.warn(`${this.fileKey(from)}: import.meta.glob(${pattern}) points outside the repository, so it is not followed`);
        continue;
      }
      this.patterns.contexts.push(globMatcher([posix(absolute)], { dot: true }));
      for (const file of safeGlob([local(pattern), ...ignore], { cwd, ignore: FILES_IGNORE, boundary: this.project.repo })) files.add(file);
    }
    for (const file of [...files].sort()) if (file !== from) this.useFile(from, file, via);
  }

  private useFile(from: string, file: string, via: string) {
    if (/[\\/](\.git|\.next|\.turbo|\.vercel)[\\/]/.test(file)) return;
    if (!this.inside(file)) {
      if (!isInNodeModules(from)) this.warn(`${this.fileKey(from)}: refers to a file outside the repository, so it is not read`);
      return;
    }
    this.recordEdge(from, file, '*');
    this.enqueue(nodeId('S', file, '*'), via);
  }

  private useJsxRuntime(file: string, source: string, via: string) {
    for (const specifier of [`${source}/jsx-runtime`, `${source}/jsx-dev-runtime`]) {
      for (const target of this.resolver.resolve(specifier, file)) {
        this.recordEdge(file, target, 'jsx');
        this.enqueue(nodeId('S', target, '*'), via);
      }
    }
  }

  /** `typeOnly`: reached through types, so imports count as types and paths in code do not matter. */
  private useUsage(file: string, module: EsmModule, usage: Usage, via: string, typeOnly = false) {
    const binding = typeOnly ? 'Y' : 'D';
    for (const ref of usage.refs) {
      if (module.decls.has(ref) || module.imports.has(ref)) this.enqueue(nodeId(binding, file, ref), via);
      else this.missingRefs.set(nodeId(binding, file, ref), via);
    }
    for (const [object, members] of usage.members) {
      if (usage.refs.has(object)) continue;
      const imported = module.imports.get(object);
      if (imported?.imported === '*') {
        // `import * as ns` used only as `ns.member`: only those members count.
        this.markLive(file, `import:${object}`, imported.text, via);
        for (const member of members) this.useImport(file, imported.source, member, imported.type || typeOnly, via);
      } else if (imported || module.decls.has(object)) this.enqueue(nodeId(binding, file, object), via);
      else this.missingRefs.set(nodeId(binding, file, object), via);
    }
    for (const specifier of usage.dynamic) this.useImport(file, specifier, '*', typeOnly, via);
    for (const specifier of usage.types) this.useImport(file, specifier, '*', true, via);
    if (typeOnly) return;
    if (!isInNodeModules(file)) for (const name of usage.env) this.readEnv(name, via);
    for (const pattern of usage.contexts) this.useContext(file, pattern, via);
    for (const path of usage.paths) this.usePath(file, path, via);
  }

  private evaluate(file: string, via: string) {
    const module = this.load(file);
    const record = this.files.get(file);
    if (record) record.evaluated = true;
    const external = isInNodeModules(file);
    if (module.kind === 'opaque') {
      this.markOpaque(file, module, via);
      for (const specifier of module.specifiers) {
        if (specifier.startsWith('style:')) this.useStyle(file, specifier.slice(6), via);
        else if (specifier.startsWith('asset:')) this.useAsset(file, specifier.slice(6), via);
        else if (specifier.startsWith('root:')) {
          if (!external) this.useRootStyle(file, specifier.slice(5), via);
        }
        else if (specifier.startsWith('/') && !this.inside(specifier)) {
          if (!external) this.warn(`${this.fileKey(file)}: refers to a file outside the repository, so it is not read`);
        } else this.useImport(file, specifier, '*', false, via);
      }
      for (const i of module.imports ?? []) this.useImport(file, i.source, i.name, i.type, via);
      if (!external) for (const name of module.env ?? []) this.readEnv(name, via);
      for (const missing of module.missing ?? []) this.patterns.missing.add(missing);
      if (!external && /\.(scss|sass|less)$/.test(file)) for (const specifier of this.project.styleGlobals) this.useStyleGlobal(file, specifier, via);
      for (const pattern of module.contexts ?? []) this.useContext(file, pattern, via);
      for (const path of module.paths ?? []) this.usePath(file, path, via);
    } else {
      // Every export of a `use server` file is an endpoint Next.js may register.
      if (module.directives.includes('use server')) this.enqueue(nodeId('S', file, '*'), via);
      if (module.effects.text) this.markLive(file, '<module>', module.effects.text, via);
      this.useUsage(file, module, module.effects.usage, via);
      this.useTypeEffects(file, module, via);
      for (const request of valueRequests(module, this.resolver.modularize)) {
        // `import 'tw-animate-css'`: a package that exports only a `style` condition.
        const targets = request.bare ? this.resolver.resolve(request.source, file) : this.resolveOrRecord(request.source, file);
        if (request.bare && targets.length === 0) {
          this.useStyle(file, request.source, via);
          continue;
        }
        for (const target of targets) {
          if (request.bare) this.recordEdge(file, target, '*');
          if (request.bare || !this.resolver.isSideEffectFree(target)) this.enqueue(nodeId('M', target), via);
        }
      }
      if (!external) {
        // Imported modules run in import order, and stylesheets cascade in it.
        // One entry counts too: switching `import()` to a static import makes the module run up front.
        const order = this.effectfulRequests(file, module).map(r => r.source);
        if (order.length > 0) this.markLive(file, '<imports>', order.join('\n'), via);
      }
    }
    if (module.jsx && !external && !(module.kind === 'esm' && module.jsxClassic)) {
      this.useJsxRuntime(file, (module.kind === 'esm' && module.jsxImportSource) || this.project.jsxImportSource, via);
    }
  }

  /** Files a request runs: what it resolves to, minus targets a `sideEffects: false` package lets the bundler drop. */
  requestTargets(file: string, request: ModuleRequest): string[] {
    const targets = this.resolver.resolve(request.source, file);
    if (request.bare && targets.length === 0) {
      const style = this.resolver.resolveStyle(request.source, file).file;
      return style ? [style] : [];
    }
    return request.bare ? targets : targets.filter(t => !this.resolver.isSideEffectFree(t));
  }

  /** Value requests of `module` whose targets have side effects, in source order. */
  effectfulRequests(file: string, module: ModuleInfo): ModuleRequest[] {
    return valueRequests(module, this.resolver.modularize).filter(r => this.requestTargets(file, r).some(t => this.effectful(t)));
  }

  isEvaluated(file: string): boolean {
    return this.files.get(file)?.evaluated === true;
  }

  /**
   * Running `file` changes something: top-level code, a stylesheet, CommonJS, or an import of
   * such a module. A module that only declares things has none, so importing it runs nothing.
   */
  effectful(file: string): boolean {
    const cached = this.effectCache.get(file);
    if (cached !== undefined) return cached;
    const own = (f: string) => {
      const module = this.load(f);
      if (module.kind === 'esm') return module.effects.runs;
      return module.reason !== 'asset' || STYLE_EXTENSIONS.has(extname(f));
    };
    const children = (f: string) => {
      const module = this.load(f);
      return valueRequests(module, this.resolver.modularize).flatMap(r => this.requestTargets(f, r));
    };
    // Per strongly connected component, so an import cycle gets one answer for all its members.
    // Iterative, since import chains can be thousands of modules long.
    const next = (f: string) => (own(f) ? [] : children(f));
    for (const component of components(file, next, f => this.effectCache.has(f))) {
      const members = new Set(component);
      const value = component.some(own) || component.some(f => children(f).some(t => !members.has(t) && this.effectCache.get(t) === true));
      for (const f of component) this.effectCache.set(f, value);
    }
    return this.effectCache.get(file) ?? false;
  }

  /** Some graph node for `file`, if the walk reached it. */
  private anyNode(file: string): string | undefined {
    if (!this.nodeByFile) {
      this.nodeByFile = new Map();
      for (const key of this.parents.keys()) {
        const owner = key.split(SEP)[1];
        if (!this.nodeByFile.has(owner)) this.nodeByFile.set(owner, key);
      }
    }
    return this.nodeByFile.get(file);
  }

  /**
   * The graph node that would make fragment `id` of `file` live if the file still had it, or had
   * it in its base form. Git mode asks this for fragments that changed but are not live: a removed
   * bare import matters when the file still runs, a removed declaration when live code still names
   * it, a declaration that lost its `export` when something asks for that export. `base` is the
   * file's base-side module, which knows what the declaration used to export.
   */
  wants(file: string, id: string, base?: ModuleInfo): string | undefined {
    const node = (kind: NodeKind, name?: string) => {
      const key = nodeId(kind, file, name);
      return this.parents.has(key) ? key : this.missingRefs.get(key);
    };
    // `export *` passes on every name but `default`.
    const starred = (name: string) => (name === 'default' ? undefined : (node('S', STAR_EXPORTS) ?? node('T', STAR_EXPORTS)));
    const exported = (name: string) => node('S', name) ?? node('T', name) ?? node('S', '*') ?? node('T', '*') ?? starred(name);
    if (id === '<module>') return this.isEvaluated(file) ? nodeId('M', file) : undefined;
    if (id.startsWith('export:')) return exported(id.slice('export:'.length));
    if (id === '' || id === '<types>' || id.startsWith('export*:')) return this.files.has(file) ? this.anyNode(file) : undefined;
    if (id.startsWith('import:')) {
      const name = id.slice('import:'.length);
      return node('D', name) ?? node('Y', name);
    }
    const direct = node('D', id) ?? node('Y', id);
    if (direct || base?.kind !== 'esm') return direct;
    for (const [name, entry] of base.exports) {
      if (entry.local !== id || entry.source !== undefined) continue;
      const hit = exported(name);
      if (hit) return hit;
    }
  }

  /** Every name `file` exports, following `export *`. Iterative, for barrels chained thousands deep. */
  exportNames(file: string): Set<string> {
    const cached = this.exportNameCache.get(file);
    if (cached) return cached;
    const targets = (f: string) => {
      const module = this.load(f);
      return module.kind === 'esm' ? module.stars.flatMap(s => this.resolver.resolve(s.source, f)) : [];
    };
    const own = (f: string) => {
      const module = this.load(f);
      return module.kind === 'esm' ? [...module.exports.keys()] : [];
    };
    // In an `export *` cycle every member re-exports every other: names are shared per component,
    // except `default`, which `export *` never passes on.
    for (const component of components(file, targets, f => this.exportNameCache.has(f))) {
      const members = new Set(component);
      const shared = new Set<string>();
      for (const f of component) {
        for (const name of own(f)) shared.add(name);
        for (const t of targets(f)) if (!members.has(t)) for (const name of this.exportNameCache.get(t) ?? []) shared.add(name);
      }
      shared.delete('default');
      for (const f of component) {
        const names = new Set(shared);
        for (const name of own(f)) names.add(name);
        this.exportNameCache.set(f, names);
      }
    }
    return this.exportNameCache.get(file) ?? new Set();
  }

  /**
   * Records `S target name` (or `S target *`) for every module `file` re-exports with `export *`,
   * however deep. Nothing in head asks for these, but git mode's `wants` must find them: deleting
   * `price` from lib.ts matters when a barrel's `export *` passed it on.
   */
  private wantThroughStars(file: string, name: string, via: string, typeOnly = false) {
    const seen = new Set([file]);
    const queue = [file];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      const module = this.load(current);
      if (module.kind !== 'esm') continue;
      for (const star of module.stars) {
        for (const target of this.resolver.resolve(star.source, current)) {
          if (seen.has(target)) continue;
          seen.add(target);
          const id = nodeId(typeOnly || star.type ? 'T' : 'S', target, name);
          if (!this.parents.has(id) && !this.missingRefs.has(id)) this.missingRefs.set(id, via);
          queue.push(target);
        }
      }
    }
  }

  private useExport(file: string, name: string, via: string) {
    this.enqueue(nodeId('M', file), via);
    const module = this.load(file);
    this.files.get(file)?.used.add(name);
    if (module.kind === 'opaque') return;

    if (name === '*') {
      for (const exported of this.exportNames(file)) this.enqueue(nodeId('S', file, exported), via);
      this.wantThroughStars(file, STAR_EXPORTS, via);
      for (const star of module.stars) {
        for (const target of this.resolver.resolve(star.source, file)) {
          if (this.load(target).kind !== 'opaque') continue;
          this.markLive(file, `export*:${star.source}`, star.text, via);
          this.enqueue(nodeId('S', target, '*'), via);
        }
      }
      return;
    }

    const entry = module.exports.get(name);
    if (entry) {
      if (entry.text) this.markLive(file, `export:${name}`, entry.text, via);
      if (entry.source !== undefined) this.useImport(file, entry.source, entry.imported ?? name, entry.type, via);
      else if (entry.local !== undefined) this.enqueue(nodeId('D', file, entry.local), via);
      return;
    }

    if (name !== 'default') {
      let found = false;
      for (const star of module.stars) {
        for (const target of this.resolveOrRecord(star.source, file, star.type)) {
          if (this.load(target).kind !== 'opaque' && !this.exportNames(target).has(name)) continue;
          found = true;
          this.markLive(file, `export*:${star.source}`, star.text, via);
          if (star.type && isInNodeModules(target)) {
            this.markPackageTypes(target, via);
            continue;
          }
          this.recordEdge(file, target, name);
          this.enqueue(nodeId(star.type ? 'T' : 'S', target, name), via);
        }
      }
      if (found) return;
    }

    if (name !== 'default') this.wantThroughStars(file, name, via);
    if (module.exportEquals) {
      this.enqueue(nodeId('D', file, 'default'), via);
      return;
    }
    if (!isInNodeModules(file)) {
      this.warn(`${this.fileKey(file)}: no export named "${name}", treating every export as used`);
    }
    this.enqueue(nodeId('S', file, '*'), via);
  }

  /** `declare global` and `declare module` blocks shape types wherever the module is reached. */
  private useTypeEffects(file: string, module: EsmModule, via: string) {
    if (!module.types.text || this.live.has(fragmentKey(this.fileKey(file), '<types>'))) return;
    this.markLive(file, '<types>', module.types.text, via);
    this.useUsage(file, module, module.types.usage, via, true);
  }

  /** An export reached through `import type`. The module does not run. */
  private useTypeExport(file: string, name: string, via: string) {
    const module = this.load(file);
    this.files.get(file)?.used.add(name);
    if (module.kind === 'opaque') {
      // A JavaScript or JSON file typed by inference: all of it can shape the type.
      this.markOpaque(file, module, via);
      return;
    }
    this.useTypeEffects(file, module, via);
    if (module.jsx && !isInNodeModules(file)) {
      // JSX element types come from the JSX runtime's package.
      const source = module.jsxImportSource ?? this.project.jsxImportSource;
      for (const target of this.resolver.resolve(`${source}/jsx-runtime`, file)) this.markPackageTypes(target, via);
    }

    if (name === '*') {
      for (const exported of this.exportNames(file)) this.enqueue(nodeId('T', file, exported), via);
      this.wantThroughStars(file, STAR_EXPORTS, via, true);
      return;
    }
    const entry = module.exports.get(name);
    if (entry) {
      if (entry.text) this.markLive(file, `export:${name}`, entry.text, via);
      if (entry.source !== undefined) this.useImport(file, entry.source, entry.imported ?? name, true, via);
      else if (entry.local !== undefined) this.enqueue(nodeId('Y', file, entry.local), via);
      return;
    }
    if (name !== 'default') {
      let found = false;
      for (const star of module.stars) {
        for (const target of this.resolveOrRecord(star.source, file, true)) {
          if (this.load(target).kind !== 'opaque' && !this.exportNames(target).has(name)) continue;
          found = true;
          this.markLive(file, `export*:${star.source}`, star.text, via);
          if (isInNodeModules(target)) this.markPackageTypes(target, via);
          else this.enqueue(nodeId('T', target, name), via);
        }
      }
      if (found) return;
    }
    if (name !== 'default') this.wantThroughStars(file, name, via, true);
    if (module.exportEquals) {
      this.enqueue(nodeId('Y', file, 'default'), via);
      return;
    }
    this.enqueue(nodeId('T', file, '*'), via);
  }

  /** A declaration or import binding reached through types. */
  private useTypeBinding(file: string, name: string, via: string) {
    const module = this.load(file);
    if (module.kind !== 'esm') return;
    const binding = module.imports.get(name);
    if (binding) {
      this.markLive(file, `import:${name}`, binding.text, via);
      this.useImport(file, binding.source, binding.imported, true, via);
      return;
    }
    const decl = module.decls.get(name);
    if (!decl) return;
    this.markLive(file, name, decl.text, via);
    this.useUsage(file, module, decl.usage, via, true);
  }

  private useBinding(file: string, name: string, via: string) {
    const module = this.load(file);
    if (module.kind !== 'esm') return;
    const binding = module.imports.get(name);
    if (binding) {
      this.markLive(file, `import:${name}`, binding.text, via);
      this.useImport(file, binding.source, binding.imported, binding.type, via);
      return;
    }
    const decl = module.decls.get(name);
    if (!decl) return;
    this.markLive(file, name, decl.text, via);
    this.useUsage(file, module, decl.usage, via);
  }
}
