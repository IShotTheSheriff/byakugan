import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { globSync } from 'tinyglobby';
import picomatch from 'picomatch';
import { GLOB_SEPARATOR, mdxModule, parseModule, type EsmModule, type ModuleInfo, type PathKind, type Usage } from './parse.ts';
import type { Project } from './project.ts';
import { findStyleFile, isInNodeModules, Resolver, type PackageInfo } from './resolve.ts';
import { isTailwindRoot, runTailwind, tailwindFallbackFiles, type TailwindResult } from './tailwind.ts';

const JS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const SEP = '\u0000';

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
}

/** Fragment ids within one module, mapped to content hashes. Same ids the graph marks live. */
export const moduleFragments = (module: ModuleInfo): Map<string, string> => {
  const out = new Map<string, string>();
  if (module.kind === 'opaque') {
    out.set('', hashOf(module.content));
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
const STYLE_REFERENCE = /@(import|use|forward|plugin|config|reference)\s+(?:url\(\s*)?(['"])([^'"\n]+)\2/g;
const STYLE_URL = /\burl\(\s*(['"]?)([^'")\s]+)\1\s*\)/g;
const SCRIPT_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Files a stylesheet pulls in: `@import`, Sass `@use`/`@forward`, Tailwind `@reference`,
 * `@plugin` and `@config`, and relative `url()` assets. Targets found next to the file become absolute paths (Sass
 * partials included). Package targets keep their specifier, prefixed `style:` for
 * stylesheets. `@plugin` and `@config` load JavaScript, so they resolve like imports.
 */
const styleReferences = (file: string, source: string): string[] => {
  const out: string[] = [];
  for (const match of source.matchAll(STYLE_REFERENCE)) {
    const rule = match[1];
    const specifier = match[3].replace(/^~/, '');
    if (/^([a-z][\w+.-]*:|\/|#)/i.test(specifier)) continue;
    const script = rule === 'plugin' || rule === 'config';
    const local = join(dirname(file), specifier);
    const found = script ? SCRIPT_SUFFIXES.map(e => local + e).find(isFile) : findStyleFile(local);
    if (found) out.push(found);
    else out.push(script || specifier.startsWith('.') ? specifier : `style:${specifier}`);
  }
  // Images and fonts next to the stylesheet. `url(/x.png)` points at public/, an input already.
  for (const match of source.matchAll(STYLE_URL)) {
    const target = match[2].split(/[?#]/)[0];
    if (target === '' || /^([a-z][\w+.-]*:|\/|#)/i.test(target)) continue;
    const asset = join(dirname(file), target);
    if (isFile(asset) && !out.includes(asset)) out.push(asset);
  }
  return out;
};

export const loadModule = (file: string, content: Buffer | string): { module: ModuleInfo; errors: string[] } => {
  const ext = extname(file);
  if (JS_EXTENSIONS.has(ext)) return parseModule(file, content.toString());
  if (ext === '.mdx' || ext === '.md') return { module: mdxModule(content.toString()), errors: [] };
  const specifiers = STYLE_EXTENSIONS.has(ext) ? styleReferences(file, content.toString()) : [];
  return { module: { kind: 'opaque', reason: 'asset', content, specifiers, jsx: false }, errors: [] };
};

const FILES_IGNORE = ['**/node_modules/**', '**/.git/**', '**/.next/**', '**/.turbo/**', '**/.vercel/**'];

const filesUnder = (dir: string): string[] => {
  try {
    return globSync('**/*', { cwd: dir, absolute: true, ignore: FILES_IGNORE, onlyFiles: true }).sort();
  } catch {
    return [];
  }
};

export const fragmentKey = (fileKey: string, fragment: string) => (fragment === '' ? fileKey : `${fileKey}#${fragment}`);

export class UsageGraph {
  readonly project: Project;
  readonly resolver: Resolver;
  readonly files = new Map<string, FileRecord>();
  readonly live = new Map<string, LiveFragment>();
  /** Graph node -> the node that reached it first (BFS, so chains are shortest). */
  readonly parents = new Map<string, string | null>();
  readonly unresolved: Unresolved[] = [];
  readonly warnings: string[] = [];
  /** file -> imported file -> names. */
  readonly edges = new Map<string, Map<string, Set<string>>>();
  /** npm package name -> names imported from project code. */
  readonly packageImports = new Map<string, Set<string>>();
  /**
   * Where computed imports and file paths point: directories read whole, `import()` patterns
   * as absolute-path regexes, and referenced paths that do not exist. Git mode checks deleted
   * files against them, since a deleted file is no longer in the graph.
   */
  readonly patterns = { trees: [] as string[], contexts: [] as RegExp[], missing: new Set<string>() };
  /** Tailwind root stylesheet -> what the Tailwind run reported for it. */
  readonly tailwind = new Map<string, TailwindResult>();
  unresolvedInPackages = 0;

  private modules = new Map<string, ModuleInfo>();
  /** Binding node ids a live usage asks for but the module does not declare -> the node that asked. */
  private missingRefs = new Map<string, string>();
  private keys = new Map<string, string>();
  private queue: string[] = [];
  private exportNameCache = new Map<string, Set<string>>();
  private collisions = new Map<string, Map<string, string>>();
  private seenUnresolved = new Set<string>();
  private seenWarnings = new Set<string>();

  constructor(project: Project, resolver?: Resolver) {
    this.project = project;
    this.resolver =
      resolver ??
      new Resolver({
        conditions: project.config.conditions,
        reactServer: project.framework === 'next',
        modularizeImports: project.config.modularizeImports,
      });
  }

  build(): this {
    for (const input of this.project.inputs) this.markInput(input);
    for (const name of this.project.packages) this.markPackageVersion(name);
    for (const entry of this.project.entries) this.enqueue(nodeId('S', entry, '*'), null);
    this.drain();
    this.useTailwind();
    this.drain();
    return this;
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
    const roots: string[] = [];
    for (const record of this.files.values()) {
      const module = this.modules.get(record.file);
      if (!record.evaluated || isInNodeModules(record.file) || module?.kind !== 'opaque') continue;
      if (STYLE_EXTENSIONS.has(extname(record.file)) && isTailwindRoot(module.content.toString())) roots.push(record.file);
    }
    if (roots.length === 0) return;
    for (const result of runTailwind({ dir: this.project.dir, roots: roots.sort() })) {
      this.tailwind.set(result.file, result);
      const via = nodeId('M', result.file);
      if (result.hash !== undefined) {
        this.markLive(result.file, '<tailwind>', result.hash, via);
        for (const dep of result.deps) if (isFile(dep)) this.enqueue(nodeId('S', dep, '*'), via);
        continue;
      }
      this.warn(
        `${this.fileKey(result.file)}: could not run Tailwind (${result.error}), so every file it may scan is hashed whole`
      );
      for (const file of tailwindFallbackFiles(this.project.dir)) this.markInput(file);
    }
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
    while (current) {
      out.push(current);
      current = this.parents.get(current);
      if (out.length > 10_000) break;
    }
    return out.reverse();
  }

  private load(file: string): ModuleInfo {
    const cached = this.modules.get(file);
    if (cached) return cached;
    let module: ModuleInfo;
    try {
      const outcome = loadModule(file, readFileSync(file));
      module = outcome.module;
      if (outcome.errors.length > 0 && !isInNodeModules(file)) {
        this.warn(`${this.fileKey(file)}: parse error, hashing the whole file (${outcome.errors[0]})`);
      }
    } catch (error) {
      module = { kind: 'opaque', reason: 'asset', content: '', specifiers: [], jsx: false };
      this.warn(`${this.fileKey(file)}: cannot read (${(error as Error).message})`);
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
    if (this.parents.has(id)) return;
    this.parents.set(id, via);
    this.queue.push(id);
  }

  private warn(message: string) {
    if (this.seenWarnings.has(message)) return;
    this.seenWarnings.add(message);
    this.warnings.push(message);
  }

  private markKey(key: string, file: string, content: string | Buffer, via: string) {
    const hash = hashOf(content);
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
    this.markKey(fragmentKey(this.fileKey(file), fragment), file, content, via);
  }

  private markInput(file: string) {
    const via = nodeId('I', file);
    this.parents.set(via, null);
    let content: string | Buffer;
    if (file === join(this.project.dir, 'package.json') && this.project.manifest) {
      // Versions are covered by hashing the installed code that is actually used.
      const manifest = { ...this.project.manifest };
      for (const field of DEPENDENCY_FIELDS) delete manifest[field];
      content = JSON.stringify(manifest);
    } else {
      try {
        content = readFileSync(file);
      } catch {
        return;
      }
    }
    this.markKey(this.fileKey(file), file, content, via);
  }

  private installedVersion(name: string): string | undefined {
    let dir = this.project.dir;
    while (true) {
      const manifest = join(dir, 'node_modules', name, 'package.json');
      if (existsSync(manifest)) {
        try {
          return String((JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version);
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
    this.parents.set(via, null);
    const declared = DEPENDENCY_FIELDS.map(f => (this.project.manifest?.[f] as Record<string, string> | undefined)?.[name]).find(Boolean);
    const version = this.installedVersion(name) ?? `not installed (${declared ?? 'undeclared'})`;
    this.markKey(`npm:${name}#<version>`, '', version, via);
  }

  private markPackageTypes(file: string, via: string) {
    const pkg = this.resolver.packageOf(file);
    if (!pkg) return;
    this.markKey(`npm:${pkg.name}#<types>`, '', pkg.version, via);
    const typesName = `@types/${pkg.name.startsWith('@') ? pkg.name.slice(1).replace('/', '__') : pkg.name}`;
    const typesVersion = this.installedVersion(typesName);
    if (typesVersion) this.markKey(`npm:${typesName}#<types>`, '', typesVersion, via);
  }

  private resolveOrRecord(specifier: string, from: string): string[] {
    const targets = this.resolver.resolve(specifier, from);
    if (targets.length === 0 && !this.resolver.isBuiltin(specifier)) {
      const key = `${from}${SEP}${specifier}`;
      if (!this.seenUnresolved.has(key)) {
        this.seenUnresolved.add(key);
        if (isInNodeModules(from)) this.unresolvedInPackages++;
        else this.unresolved.push({ specifier, from });
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
    const modular = this.resolver.modularized(specifier, imported);
    let targets = modular ? this.resolver.resolve(modular, from) : [];
    let name = 'default';
    if (targets.length === 0) {
      targets = this.resolveOrRecord(specifier, from);
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
    if (found.file) {
      this.recordEdge(from, found.file, '*');
      this.enqueue(nodeId('S', found.file, '*'), via);
    } else if (found.package) {
      const version = this.installedVersion(found.package) ?? 'not installed';
      this.markKey(`npm:${found.package}#<version>`, '', version, via);
    } else this.resolveOrRecord(specifier, from);
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
    const absolute = posix(resolve(dirname(from), pattern.replace(/\*/g, SEP)));
    const regex = new RegExp(`^${absolute.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll(SEP, '.*')}$`);
    this.patterns.contexts.push(regex);
    for (const file of filesUnder(dir)) {
      if (file !== from && regex.test(posix(file))) this.useFile(from, file, via);
    }
  }

  /** Paths in code: `localFont({ src: './a.woff2' })`, `new URL(x, import.meta.url)`, `join(process.cwd(), ...)`. */
  private usePath(from: string, entry: string, via: string) {
    const [kind, path] = entry.split(SEP) as [PathKind, string];
    const external = isInNodeModules(from);
    if (kind === 'glob') return this.useGlob(from, path.split(GLOB_SEPARATOR), via);
    if (external && kind !== 'file') return;
    const tree = kind === 'file-tree' || kind === 'cwd-tree';
    const bases = kind === 'rel' ? [dirname(from), this.project.dir] : kind.startsWith('cwd') ? [this.project.dir] : [dirname(from)];
    for (const base of bases) {
      const target = resolve(base, path);
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
      for (const file of filesUnder(target)) this.useFile(from, file, via);
      return;
    }
    if (!external) for (const base of bases) this.patterns.missing.add(resolve(base, path));
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
      const ignore = patterns.filter(p => p.startsWith('!') && base(p.slice(1)) === cwd).map(p => local(p.slice(1)));
      this.patterns.contexts.push(picomatch.makeRe(posix(resolve(cwd, local(pattern))), { dot: true }));
      for (const file of globSync(local(pattern), { cwd, absolute: true, ignore: [...ignore, ...FILES_IGNORE], onlyFiles: true, expandDirectories: false })) {
        files.add(file);
      }
    }
    for (const file of [...files].sort()) if (file !== from) this.useFile(from, file, via);
  }

  private useFile(from: string, file: string, via: string) {
    if (/[\\/](\.git|\.next|\.turbo|\.vercel)[\\/]/.test(file)) return;
    this.recordEdge(from, file, '*');
    this.enqueue(nodeId('S', file, '*'), via);
  }

  private useJsxRuntime(file: string, via: string) {
    const source = this.project.jsxImportSource;
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
    for (const pattern of usage.contexts) this.useContext(file, pattern, via);
    for (const path of usage.paths) this.usePath(file, path, via);
  }

  private evaluate(file: string, via: string) {
    const module = this.load(file);
    const record = this.files.get(file);
    if (record) record.evaluated = true;
    const external = isInNodeModules(file);
    if (module.kind === 'opaque') {
      this.markLive(file, '', module.content, via);
      for (const specifier of module.specifiers) {
        if (specifier.startsWith('style:')) this.useStyle(file, specifier.slice(6), via);
        else this.useImport(file, specifier, '*', false, via);
      }
      for (const pattern of module.contexts ?? []) this.useContext(file, pattern, via);
      for (const path of module.paths ?? []) this.usePath(file, path, via);
    } else {
      // Every export of a `use server` file is an endpoint Next.js may register.
      if (module.directives.includes('use server')) this.enqueue(nodeId('S', file, '*'), via);
      if (module.effects.text) this.markLive(file, '<module>', module.effects.text, via);
      this.useUsage(file, module, module.effects.usage, via);
      this.useTypeEffects(file, module, via);
      for (const request of module.requests) {
        if (request.type || (request.named && this.resolver.modularize[request.source])) continue;
        // `import 'tw-animate-css'`: a package that exports only a `style` condition.
        const targets = request.bare ? this.resolver.resolve(request.source, file) : this.resolveOrRecord(request.source, file);
        if (request.bare && targets.length === 0) {
          this.useStyle(file, request.source, via);
          continue;
        }
        for (const target of targets) {
          if (request.bare || !this.resolver.isSideEffectFree(target)) this.enqueue(nodeId('M', target), via);
        }
      }
    }
    if (module.jsx && !external) this.useJsxRuntime(file, via);
  }

  /**
   * The graph node that would make fragment `id` of `file` live if the file still had it.
   * Git mode asks this for fragments only the base side has: removing a bare import matters
   * when the file still runs, removing a declaration matters when live code still names it.
   */
  wants(file: string, id: string): string | undefined {
    const node = (kind: NodeKind, name?: string) => {
      const key = nodeId(kind, file, name);
      return this.parents.has(key) ? key : this.missingRefs.get(key);
    };
    if (id === '<module>') return this.files.get(file)?.evaluated ? nodeId('M', file) : undefined;
    if (id.startsWith('export:')) {
      const name = id.slice('export:'.length);
      return node('S', name) ?? node('T', name) ?? node('S', '*') ?? node('T', '*');
    }
    if (id === '' || id === '<types>' || id.startsWith('export*:')) {
      if (!this.files.has(file)) return;
      const prefix = `${SEP}${file}`;
      for (const key of this.parents.keys()) if (key.slice(1) === prefix || key.slice(1).startsWith(prefix + SEP)) return key;
      return;
    }
    const name = id.startsWith('import:') ? id.slice('import:'.length) : id;
    return node('D', name) ?? node('Y', name);
  }

  /** Every name `file` exports, following `export *`. */
  exportNames(file: string): Set<string> {
    const cached = this.exportNameCache.get(file);
    if (cached) return cached;
    const names = new Set<string>();
    this.exportNameCache.set(file, names);
    const module = this.load(file);
    if (module.kind !== 'esm') return names;
    for (const name of module.exports.keys()) names.add(name);
    for (const star of module.stars) {
      for (const target of this.resolver.resolve(star.source, file)) {
        for (const name of this.exportNames(target)) if (name !== 'default') names.add(name);
      }
    }
    return names;
  }

  private useExport(file: string, name: string, via: string) {
    this.enqueue(nodeId('M', file), via);
    const module = this.load(file);
    this.files.get(file)?.used.add(name);
    if (module.kind === 'opaque') return;

    if (name === '*') {
      for (const exported of this.exportNames(file)) this.enqueue(nodeId('S', file, exported), via);
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
        for (const target of this.resolveOrRecord(star.source, file)) {
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
      this.markLive(file, '', module.content, via);
      return;
    }
    this.useTypeEffects(file, module, via);
    if (module.jsx && !isInNodeModules(file)) {
      // JSX element types come from the JSX runtime's package.
      for (const target of this.resolver.resolve(`${this.project.jsxImportSource}/jsx-runtime`, file)) this.markPackageTypes(target, via);
    }

    if (name === '*') {
      for (const exported of this.exportNames(file)) this.enqueue(nodeId('T', file, exported), via);
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
        for (const target of this.resolveOrRecord(star.source, file)) {
          if (this.load(target).kind !== 'opaque' && !this.exportNames(target).has(name)) continue;
          found = true;
          this.markLive(file, `export*:${star.source}`, star.text, via);
          if (isInNodeModules(target)) this.markPackageTypes(target, via);
          else this.enqueue(nodeId('T', target, name), via);
        }
      }
      if (found) return;
    }
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
