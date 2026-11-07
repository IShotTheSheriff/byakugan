import { parseSync, visitorKeys } from 'oxc-parser';
import { isInNodeModules } from './resolve.ts';

/** Names a piece of code refers to. Collected per top-level declaration. */
export interface Usage {
  /** Identifiers used as plain references. */
  refs: Set<string>;
  /** `ns.member` style accesses, keyed by the object identifier. */
  members: Map<string, Set<string>>;
  /** Specifiers of `import('x')` and `require('x')`. */
  dynamic: Set<string>;
  /** Specifiers of `import('x').T` in type positions. */
  types: Set<string>;
  /**
   * `import(\`./messages/${locale}.json\`)` and friends, with each computed part as `*`.
   * A lone `*` means the specifier is fully computed.
   */
  contexts: Set<string>;
  /** Files the code points at by path. `kind\0path`, see `PathKind`. */
  paths: Set<string>;
  /** Environment variables read by name: `process.env.X`, `import.meta.env.X`, `const { X } = process.env`. */
  env: Set<string>;
}

/**
 * - `rel`: a `./x.ext` string literal; relative to the file, then to the project.
 * - `file`, `cwd`: `new URL(x, import.meta.url)`, `join(__dirname, x)`, `join(process.cwd(), x)`.
 * - `file-tree`, `cwd-tree`: the same with a computed tail; the static part is a directory.
 * - `glob`: Vite `import.meta.glob` patterns joined by `\u0001`. `/` is the project root.
 */
export type PathKind = 'rel' | 'file' | 'cwd' | 'file-tree' | 'cwd-tree' | 'glob' | 'alias';

export const GLOB_SEPARATOR = '\u0001';

/** One top-level binding (or a merged group of them: overloads, interface merging, destructuring). */
export interface Decl {
  names: string[];
  text: string;
  usage: Usage;
}

export interface ImportBinding {
  local: string;
  source: string;
  /** `default`, `*` for namespace imports, or the imported name. */
  imported: string;
  type: boolean;
  text: string;
}

export interface ExportEntry {
  name: string;
  /** Local binding this export points at. */
  local?: string;
  /** Re-export source. */
  source?: string;
  imported?: string;
  type: boolean;
  /** Set for specifier-style exports, which are fragments of their own. */
  text?: string;
}

export interface StarExport {
  source: string;
  type: boolean;
  text: string;
}

export interface ModuleRequest {
  source: string;
  /** `import './x'` with no bindings. */
  bare: boolean;
  type: boolean;
  /** Only named bindings (no default or namespace). Used for modularized imports. */
  named: boolean;
}

export interface EsmModule {
  kind: 'esm';
  imports: Map<string, ImportBinding>;
  exports: Map<string, ExportEntry>;
  stars: StarExport[];
  decls: Map<string, Decl>;
  /**
   * Directives and top-level statements that run when the module is evaluated. `runs` is false
   * when the text holds only JSX pragmas, which change how the file compiles but run nothing.
   */
  effects: { text: string; usage: Usage; runs: boolean };
  /** `declare global { ... }` and `declare module 'x' { ... }`: types only, they never run. */
  types: { text: string; usage: Usage };
  requests: ModuleRequest[];
  /** `export = x` (TypeScript CommonJS export). */
  exportEquals: boolean;
  /** Module directives such as `use client` and `use server`. */
  directives: string[];
  jsx: boolean;
  /** JSX compiles to factory calls (`jsx: "react"`, `@jsx h`), not runtime imports. */
  jsxClassic: boolean;
  /** `@jsxImportSource` pragma. */
  jsxImportSource?: string;
}

/** Compiler settings that change what a module's code means. */
export interface ParseOptions {
  /** `import { type X } from './x'` keeps `import {} from './x'`, so `./x` still runs. */
  verbatimModuleSyntax?: boolean;
  /** TypeScript `jsx: "react"`: JSX calls `jsxFactory`, which must be in scope. */
  jsxClassic?: boolean;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  /** TypeScript checks JavaScript files, so JSDoc tags in them are types. */
  checkJs?: boolean;
}

export interface OpaqueModule {
  kind: 'opaque';
  reason: 'commonjs' | 'asset' | 'parse-error' | 'mdx' | 'component';
  content: string | Buffer;
  /** Content hash for files too big to keep in memory. Wins over `content`. */
  hash?: string;
  specifiers: string[];
  /** Stylesheets only: absolute paths of `url()` targets that do not exist. */
  missing?: string[];
  /** Single-file components only: imports of their `<script>` blocks, by imported name (`*` for all). */
  imports?: Array<{ source: string; name: string; type: boolean }>;
  /** CommonJS and single-file components: see `Usage`. */
  contexts?: string[];
  env?: string[];
  paths?: string[];
  jsx: boolean;
}

export type ModuleInfo = EsmModule | OpaqueModule;

interface N {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const isNode = (value: unknown): value is N =>
  typeof value === 'object' && value !== null && typeof (value as N).type === 'string';

const node = (value: unknown): N | undefined => (isNode(value) ? value : undefined);

const nodes = (value: unknown): N[] => (Array.isArray(value) ? value.filter(isNode) : []);

const nameOf = (value: unknown): string => {
  const n = node(value);
  if (!n) return '';
  if (typeof n.name === 'string') return n.name;
  return String(n.value);
};

const staticString = (value: unknown): string | undefined => {
  const n = node(value);
  if (!n) return;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && nodes(n.expressions).length === 0) {
    const cooked = (nodes(n.quasis)[0]?.value as { cooked?: unknown } | undefined)?.cooked;
    if (typeof cooked === 'string') return cooked;
  }
  if (n.type === 'TSLiteralType') return staticString(n.literal);
};

export const newUsage = (): Usage => ({
  refs: new Set(),
  members: new Map(),
  dynamic: new Set(),
  types: new Set(),
  contexts: new Set(),
  paths: new Set(),
  env: new Set(),
});

/** Glob-like pattern for a computed specifier: static parts kept, computed parts as `*`. */
const specifierPattern = (value: unknown): string => {
  const n = node(value);
  if (!n) return '*';
  const fixed = staticString(n);
  if (fixed !== undefined) return fixed;
  if (n.type === 'TemplateLiteral') {
    const quasis = nodes(n.quasis).map(q => String((q.value as { cooked?: unknown } | undefined)?.cooked ?? ''));
    return quasis.join('*').replace(/\*+/g, '*');
  }
  if (n.type === 'BinaryExpression' && n.operator === '+') return `${specifierPattern(n.left)}${specifierPattern(n.right)}`.replace(/\*+/g, '*');
  return '*';
};

const RELATIVE_FILE = /^\.\.?\/[^\n*?"<>|]*\.[A-Za-z0-9]{1,10}$/;
/** `'~/assets/main.css'` in a Nuxt config, `'@/styles.css'` or `'$lib/x.css'`: a file behind a path alias. */
const ALIAS_FILE = /^(?:~~|@@|~|@|\$lib)\/[^\n*?"<>|]*\.[A-Za-z0-9]{1,10}$/;

const isProcessCwd = (n: N | undefined) => {
  const callee = node(n?.callee);
  return n?.type === 'CallExpression' && callee?.type === 'MemberExpression' && nameOf(callee.object) === 'process' && nameOf(callee.property) === 'cwd';
};

const isFileDir = (n: N | undefined) =>
  (n?.type === 'Identifier' && n.name === '__dirname') ||
  (n?.type === 'MemberExpression' && node(n.object)?.type === 'MetaProperty' && nameOf(n.property) === 'dirname');

const isImportMeta = (n: N | undefined, property: string) =>
  n?.type === 'MemberExpression' && node(n.object)?.type === 'MetaProperty' && nameOf(n.property) === property;

const isImportMetaUrl = (n: N | undefined) => isImportMeta(n, 'url');

/** `import.meta.glob('./routes/*.tsx')` and `import.meta.glob(['./a/*', '!./a/skip.ts'])`. */
const globPatterns = (n: N): string[] | undefined => {
  const callee = node(n.callee);
  if (!isImportMeta(callee, 'glob') && !isImportMeta(callee, 'globEager')) return;
  const first = node(nodes(n.arguments)[0]);
  const list = first?.type === 'ArrayExpression' ? nodes(first.elements) : first ? [first] : [];
  const patterns = list.map(staticString);
  return patterns.every((p): p is string => p !== undefined) && patterns.length > 0 ? patterns : [];
};

/** Hono `serveStatic({ root: './public' })` and `serveStatic({ path: './favicon.ico' })`. */
const staticRoot = (n: N): string | undefined => {
  if (nameOf(n.callee) !== 'serveStatic') return;
  const options = node(nodes(n.arguments)[0]);
  if (options?.type !== 'ObjectExpression') return;
  const values = new Map<string, string | undefined>();
  for (const p of nodes(options.properties)) if (p.type === 'Property') values.set(nameOf(p.key), staticString(p.value));
  const root = values.get('root') ?? '.';
  const path = values.get('path');
  if (values.has('path')) return path === undefined ? `cwd-tree\0${root}` : `cwd\0${root}/${path}`;
  return `cwd\0${root}`;
};

/** `join(process.cwd(), 'content', slug)` style calls: the base and the static leading path. */
const joinedPath = (n: N): string | undefined => {
  const callee = node(n.callee);
  const fn = callee?.type === 'Identifier' ? callee.name : callee?.type === 'MemberExpression' && !callee.computed ? nameOf(callee.property) : undefined;
  if (fn !== 'join' && fn !== 'resolve') return;
  const [first, ...rest] = nodes(n.arguments);
  const base = isProcessCwd(first) ? 'cwd' : isFileDir(first) ? 'file' : undefined;
  if (!base) return;
  const parts: string[] = [];
  for (const arg of rest) {
    const part = staticString(arg);
    if (part !== undefined) {
      parts.push(part);
      continue;
    }
    const pattern = specifierPattern(arg);
    const prefix = `${parts.join('/')}/${pattern.slice(0, pattern.indexOf('*'))}`;
    return `${base}-tree\0${prefix.slice(0, prefix.lastIndexOf('/')).replace(/^\/+/, '')}`;
  }
  return `${base}\0${parts.join('/')}`;
};

const mergeUsage = (into: Usage, from: Usage) => {
  for (const ref of from.refs) into.refs.add(ref);
  for (const [object, members] of from.members) {
    const set = into.members.get(object);
    if (set) for (const m of members) set.add(m);
    else into.members.set(object, new Set(members));
  }
  for (const d of from.dynamic) into.dynamic.add(d);
  for (const t of from.types) into.types.add(t);
  for (const c of from.contexts) into.contexts.add(c);
  for (const p of from.paths) into.paths.add(p);
  for (const e of from.env) into.env.add(e);
};

const addMember = (usage: Usage, object: string, member: string) => {
  const set = usage.members.get(object);
  if (set) set.add(member);
  else usage.members.set(object, new Set([member]));
};

const KEYED = new Set([
  'Property',
  'MethodDefinition',
  'PropertyDefinition',
  'AccessorProperty',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
  'TSAbstractAccessorProperty',
  'TSPropertySignature',
  'TSMethodSignature',
  'ImportAttribute',
]);

let sawJsx = false;
/** Set while parsing a file whose JSX compiles to factory calls. */
let jsxFactories: string[] | undefined;
let jsxFragmentFactories: string[] | undefined;

/** `React.createElement` refers to `React`, `h` to `h`. */
const useFactory = (usage: Usage, factory: string) => {
  const [root, member] = factory.split('.');
  if (!root) return;
  if (member) addMember(usage, root, member);
  else usage.refs.add(root);
};

/** `require.context('./icons', true, /\.svg$/)` and `import.meta.webpackContext('./icons')`: a directory read whole. */
const requireContext = (n: N, usage: Usage): boolean => {
  const callee = node(n.callee);
  if (callee?.type !== 'MemberExpression') return false;
  const isRequire = nameOf(callee.object) === 'require' && nameOf(callee.property) === 'context';
  if (!isRequire && !isImportMeta(callee, 'webpackContext')) return false;
  const dir = staticString(nodes(n.arguments)[0]);
  if (dir === undefined) usage.contexts.add('*');
  else usage.paths.add(`file-tree\0${dir}`);
  return true;
};

const NONE: unknown[] = [];

/** `process.env` or `import.meta.env`. */
const isEnvObject = (n: N | undefined) => {
  if (n?.type !== 'MemberExpression' || n.computed || nameOf(n.property) !== 'env') return false;
  const object = node(n.object);
  return (object?.type === 'Identifier' && object.name === 'process') || object?.type === 'MetaProperty';
};

/**
 * One step of `walk`: records what `n` refers to and returns the children still to visit,
 * or undefined to visit every child.
 */
const visit = (n: N, usage: Usage): unknown[] | undefined => {
  switch (n.type) {
    case 'Identifier':
    case 'JSXIdentifier':
      usage.refs.add(n.name as string);
      return;
    case 'MemberExpression': {
      const object = node(n.object);
      if (isEnvObject(object)) {
        const name = n.computed ? staticString(n.property) : nameOf(n.property);
        if (name) {
          usage.env.add(name);
          if (nameOf(node(object?.object)) === 'process') addMember(usage, 'process', 'env');
          return n.computed ? [n.property] : NONE;
        }
      }
      // `import.meta.env` used whole: Vite inlines it as an object of every exposed variable.
      if (isEnvObject(n) && object?.type === 'MetaProperty') {
        usage.env.add('*');
        return NONE;
      }
      if (!n.computed && object?.type === 'Identifier') {
        addMember(usage, object.name as string, nameOf(n.property));
        return NONE;
      }
      return n.computed ? [n.object, n.property] : [n.object];
    }
    case 'JSXMemberExpression': {
      const object = node(n.object);
      if (object?.type !== 'JSXIdentifier') return [n.object];
      addMember(usage, object.name as string, nameOf(n.property));
      return NONE;
    }
    case 'TSQualifiedName': {
      const left = node(n.left);
      if (left?.type !== 'Identifier') return [n.left];
      addMember(usage, left.name as string, nameOf(n.right));
      return NONE;
    }
    case 'JSXOpeningElement':
    case 'JSXOpeningFragment':
      sawJsx = true;
      for (const factory of jsxFactories ?? []) useFactory(usage, factory);
      if (n.type === 'JSXOpeningFragment') for (const factory of jsxFragmentFactories ?? []) useFactory(usage, factory);
      return;
    case 'JSXClosingElement':
    case 'JSXClosingFragment':
    case 'JSXNamespacedName':
    case 'MetaProperty':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'PrivateIdentifier':
      return NONE;
    case 'JSXAttribute':
      return [n.value];
    case 'LabeledStatement':
      return [n.body];
    case 'VariableDeclarator': {
      const id = node(n.id);
      const init = node(n.init);
      if (id?.type === 'ObjectPattern' && isEnvObject(init)) {
        const properties = nodes(id.properties);
        for (const p of properties) if (p.type === 'Property' && !p.computed) usage.env.add(nameOf(p.key));
        // `const { A, ...rest } = import.meta.env` keeps the whole object.
        if (properties.some(p => p.type === 'RestElement' || p.computed) && node(init?.object)?.type === 'MetaProperty') usage.env.add('*');
        return [n.id, ...(nameOf(node(init?.object)) === 'process' ? [init?.object] : [])];
      }
      return;
    }
    case 'TSEnumMember':
      return [n.initializer];
    case 'Literal':
      if (typeof n.value === 'string' && RELATIVE_FILE.test(n.value)) usage.paths.add(`rel\0${n.value}`);
      else if (typeof n.value === 'string' && ALIAS_FILE.test(n.value)) usage.paths.add(`alias\0${n.value}`);
      return NONE;
    case 'TemplateLiteral': {
      const fixed = staticString(n);
      if (fixed !== undefined && RELATIVE_FILE.test(fixed)) usage.paths.add(`rel\0${fixed}`);
      return;
    }
    case 'ImportExpression': {
      const specifier = staticString(n.source);
      if (specifier !== undefined) {
        usage.dynamic.add(specifier);
        return [n.options];
      }
      usage.contexts.add(specifierPattern(n.source));
      return [n.source, n.options];
    }
    case 'CallExpression': {
      const callee = node(n.callee);
      const args = nodes(n.arguments);
      if (callee?.type === 'Identifier' && callee.name === 'require' && args.length === 1) {
        const specifier = staticString(args[0]);
        if (specifier !== undefined) {
          usage.dynamic.add(specifier);
          return NONE;
        }
        usage.contexts.add(specifierPattern(args[0]));
        return;
      }
      if (requireContext(n, usage)) return;
      const path = joinedPath(n) ?? staticRoot(n);
      if (path !== undefined) usage.paths.add(path);
      const globs = globPatterns(n);
      if (globs?.length === 0) usage.contexts.add('*');
      else if (globs) usage.paths.add(`glob\0${globs.join(GLOB_SEPARATOR)}`);
      return;
    }
    case 'NewExpression': {
      const args = nodes(n.arguments);
      const target = args.length === 2 && nameOf(n.callee) === 'URL' && isImportMetaUrl(args[1]) ? staticString(args[0]) : undefined;
      if (target !== undefined && !/^[a-z][\w+.-]*:/i.test(target)) usage.paths.add(`file\0${target}`);
      return;
    }
    case 'TSImportType': {
      const specifier = staticString(n.source ?? n.argument);
      if (specifier !== undefined) usage.types.add(specifier);
      return [n.typeArguments];
    }
  }
};

/**
 * Collects every name a subtree might refer to. It over-approximates on purpose:
 * shadowed locals and binding names count as references. For change detection a
 * false "used" costs a rebuild, a false "unused" costs a missed one.
 * Iterative, so generated code nested thousands of levels deep does not overflow the stack.
 */
const walk = (root: unknown, usage: Usage): void => {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
      continue;
    }
    if (!isNode(value)) continue;
    const children = visit(value, usage);
    if (children) {
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      continue;
    }
    const keys = visitorKeys[value.type];
    if (!keys) continue;
    const skipKey = KEYED.has(value.type) && !value.computed;
    for (let i = keys.length - 1; i >= 0; i--) {
      if (skipKey && keys[i] === 'key') continue;
      stack.push(value[keys[i]]);
    }
  }
};

const bindingNames = (pattern: unknown, out: string[] = []): string[] => {
  const n = node(pattern);
  if (!n) return out;
  switch (n.type) {
    case 'Identifier':
      out.push(n.name as string);
      break;
    case 'ObjectPattern':
      for (const p of nodes(n.properties)) bindingNames(p.type === 'RestElement' ? p.argument : p.value, out);
      break;
    case 'ArrayPattern':
      for (const e of nodes(n.elements)) bindingNames(e, out);
      break;
    case 'RestElement':
      bindingNames(n.argument, out);
      break;
    case 'AssignmentPattern':
      bindingNames(n.left, out);
      break;
  }
  return out;
};

const rootIdentifier = (expression: N): string | undefined => {
  let current: N | undefined = expression;
  while (current?.type === 'MemberExpression') current = node(current.object);
  return current?.type === 'Identifier' ? (current.name as string) : undefined;
};

type ParseResult = ReturnType<typeof parseSync>;

const REQUIRE_CALL = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Fatal parse errors leave an empty AST; the module record still lists static imports. */
const parseErrorFallback = (source: string, result: ParseResult): OpaqueModule => {
  const specifiers = new Set<string>();
  for (const i of result.module.staticImports) specifiers.add(i.moduleRequest.value);
  for (const e of result.module.staticExports) for (const entry of e.entries) if (entry.moduleRequest) specifiers.add(entry.moduleRequest.value);
  for (const d of result.module.dynamicImports) {
    const raw = source.slice(d.moduleRequest.start, d.moduleRequest.end);
    if (/^(['"`])[^'"`$]*\1$/.test(raw)) specifiers.add(raw.slice(1, -1));
  }
  for (const match of source.matchAll(REQUIRE_CALL)) specifiers.add(match[1]);
  return { kind: 'opaque', reason: 'parse-error', content: source, specifiers: [...specifiers], jsx: /<\/|\/>/.test(source) };
};

export interface ParseOutcome {
  module: ModuleInfo;
  errors: string[];
}

/**
 * Like Babel: the pragma starts a comment line (after `*` in a block comment). `// pass @jsx through` is prose.
 * It says `(?:\*[ \t]*)?` because `\*?[ \t]*` puts two `[ \t]*` side by side, which makes a long run of
 * spaces quadratic.
 */
const JSX_PRAGMA = /(?:^|\n)[ \t]*(?:\*[ \t]*)?@(jsx|jsxFrag|jsxImportSource|jsxRuntime)[ \t]+([^\s*]+)/g;

/** `@jsx h`, `@jsxFrag Fragment`, `@jsxImportSource @emotion/react`, `@jsxRuntime classic`. */
const jsxPragmas = (result: ParseResult) => {
  const found: Record<string, string> = {};
  const texts: string[] = [];
  for (const comment of result.comments ?? []) {
    const matches = [...comment.value.matchAll(JSX_PRAGMA)];
    if (matches.length === 0) continue;
    texts.push(comment.value.trim());
    for (const m of matches) found[m[1]] = m[2];
  }
  return { found, text: texts.join('\n') };
};

type Comment = ParseResult['comments'][number];

/**
 * Comments that change what a tool makes of the code: minifier annotations such as `#__PURE__`,
 * bundler hints such as `webpackChunkName` and `@vite-ignore`, legal comments, TypeScript
 * directives, test environments and coverage hints. `//!`, `/*!` and `///` comments count too.
 */
const SIGNIFICANT_COMMENT =
  /[@#]__[A-Z_]+__|@(?:license|preserve|internal|refresh|vite-ignore|ts-ignore|ts-expect-error|ts-nocheck|ts-check|jest-environment|vitest-environment)\b|\b(?:webpack|turbopack)[A-Z]|\b(?:istanbul|c8|v8)[ \t]+ignore\b|\bnode:coverage[ \t]|^[#@][ \t]*source(?:Mapping)?URL=|^\s*(?:GraphQL|graphql|gql)\s*$/;
const JSX_PRAGMA_LINE = new RegExp(JSX_PRAGMA.source);
/** Matches what `\s` matches, ECMAScript white space and line terminators. */
const isSpace = (c: number) =>
  c === 32 ||
  (c >= 9 && c <= 13) ||
  (c >= 0xa0 &&
    (c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff));
const JS_FILE = /\.[cm]?jsx?$/;

const isSignificant = (comment: Comment, jsdoc: boolean) =>
  comment.value.startsWith('!') ||
  (comment.type === 'Line' && comment.value.startsWith('/')) ||
  (jsdoc && comment.type === 'Block' && comment.value.startsWith('*') && comment.value.includes('@')) ||
  SIGNIFICANT_COMMENT.test(comment.value) ||
  JSX_PRAGMA_LINE.test(comment.value);

/**
 * The text a JSX compiler keeps of a JSX text child: whitespace touching a line break goes,
 * lines left empty go, the rest join with a space. Babel's `cleanJSXElementLiteralChild`
 * and TypeScript agree on this. Tabs stay, since Babel turns them into spaces and TypeScript
 * does not.
 */
const jsxText = (raw: string): string => {
  const lines = raw.split(/\r\n|\n|\r/);
  if (lines.length === 1) return raw;
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let from = 0;
    let to = line.length;
    if (i > 0) while (from < to && (line[from] === ' ' || line[from] === '\t')) from++;
    if (i < lines.length - 1) while (to > from && (line[to - 1] === ' ' || line[to - 1] === '\t')) to--;
    if (from < to) kept.push(line.slice(from, to));
  }
  return kept.join(' ');
};

/** Index of the first item that starts at or after `pos`. */
const firstFrom = (items: Array<{ start: number }>, pos: number) => {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (items[mid].start < pos) low = mid + 1;
    else high = mid;
  }
  return low;
};

/** Keys that hold where code sits or how it was spelled, not what it does. */
const SPELLING_KEYS = new Set(['start', 'end', 'range', 'loc']);
const PARENS = new Set(['ParenthesizedExpression', 'TSParenthesizedType']);

/**
 * Fragment text from the syntax tree, so a formatter run changes nothing: positions, quote
 * style, parentheses, semicolons and trailing commas leave no trace. The tree keeps what ASI
 * decided (`return\nx` is `return; x`), and the text of literals and template parts. JSX text
 * becomes what the compiler keeps of it, and JSX children holding nothing but a comment go.
 * Significant comments stay, each before the node that follows it, the rest at the end.
 */
const canonicalText = (source: string, significant: Comment[]) => {
  const at = new Map<number, Comment[]>();
  for (const c of significant) {
    const pos = skipSpace(source, c.end);
    const list = at.get(pos);
    if (list) list.push(c);
    else at.set(pos, [c]);
  }
  const cleaned = (n: N | undefined) => (n?.type === 'JSXText' ? jsxText(source.slice(n.start, n.end)) : undefined);
  const holdsSignificant = (n: N) => (significant[firstFrom(significant, n.start)]?.start ?? Infinity) < n.end;
  /** An empty child such as `{}`, or one with only a comment in it, compiles to nothing. */
  const blank = (n: N | undefined) =>
    n?.type === 'JSXExpressionContainer' && node(n.expression)?.type === 'JSXEmptyExpression' && !holdsSignificant(n);
  const children = (list: N[]) => {
    const out: unknown[] = [];
    for (let i = 0; i < list.length; i++) {
      const child = list[i];
      if (child.type === 'JSXText') {
        const text = cleaned(child) as string;
        if (text !== '') out.push({ type: 'JSXText', value: text });
        continue;
      }
      if (!blank(child)) {
        out.push(child);
        continue;
      }
      let j = i;
      while (j < list.length && (blank(list[j]) || cleaned(list[j]) === '')) j++;
      // `a{/* note */}b` compiles to two texts and `ab` to one, so the braces stay between texts.
      if (cleaned(list[i - 1]) && cleaned(list[j])) out.push('{}');
      i = j - 1;
    }
    return out;
  };
  return (n: N, start: number, end: number): string => {
    const used = new Set<Comment>();
    /** What JSON.stringify with a replacer would serialize for `holder[key]`, undefined to leave it out. */
    const prepare = (holder: unknown, key: string, value: unknown): unknown => {
      if (SPELLING_KEYS.has(key)) return undefined;
      // `raw` spells a literal (`'a'` or `"a"`), except in a template part, where `String.raw` reads it.
      if (key === 'raw' && isNode(holder) && holder.type !== 'TemplateElement') return undefined;
      if (typeof value === 'bigint') return `${value}n`;
      // JSON writes `1e999` as `null`, which would make it equal to the `null` literal.
      if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
      if (typeof value === 'function' || typeof value === 'symbol') return undefined;
      if (!isNode(value)) return value;
      let current = value;
      while (PARENS.has(current.type) && isNode(current.expression ?? current.typeAnnotation)) current = (current.expression ?? current.typeAnnotation) as N;
      const notes = (at.get(value.start) ?? []).concat(current === value ? [] : (at.get(current.start) ?? [])).filter(c => !used.has(c));
      for (const c of notes) used.add(c);
      const out: Record<string, unknown> = notes.length > 0 ? { comments: notes.map(c => source.slice(c.start, c.end)), ...current } : current;
      if (current.type === 'JSXElement' || current.type === 'JSXFragment') return { ...out, children: children(nodes(current.children)) };
      return out;
    };
    // Iterative, so code nested thousands of levels deep does not overflow the stack.
    const parts: string[] = [];
    const stack: Array<string | { value: unknown }> = [{ value: prepare(undefined, '', n) }];
    while (stack.length > 0) {
      const item = stack.pop() as string | { value: unknown };
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      const value = item.value;
      if (value === null || typeof value !== 'object') {
        parts.push(value === undefined ? 'null' : JSON.stringify(value));
        continue;
      }
      if (value instanceof RegExp) {
        parts.push('{}');
        continue;
      }
      if (Array.isArray(value)) {
        stack.push(']');
        for (let i = value.length - 1; i >= 0; i--) {
          const element = prepare(value, String(i), value[i]);
          stack.push({ value: element === undefined ? null : element });
          if (i > 0) stack.push(',');
        }
        stack.push('[');
        continue;
      }
      const entries: Array<[string, unknown]> = [];
      for (const key of Object.keys(value)) {
        const prepared = prepare(value, key, (value as Record<string, unknown>)[key]);
        if (prepared !== undefined) entries.push([key, prepared]);
      }
      stack.push('}');
      for (let i = entries.length - 1; i >= 0; i--) {
        stack.push({ value: entries[i][1] });
        stack.push(`${i > 0 ? ',' : ''}${JSON.stringify(entries[i][0])}:`);
      }
      stack.push('{');
    }
    const text = parts.join('');
    const rest = significant.filter(c => c.start >= start && c.end <= end && !used.has(c));
    return rest.length > 0 ? `${text}\n${rest.map(c => source.slice(c.start, c.end)).join('\n')}` : text;
  };
};

interface SourceText {
  /** Fragment text for node `n`, which spans `start` to `end`. See `canonicalText`. */
  clean: (n: N, start: number, end: number) => string;
  /** Significant comments, which count wherever they are. */
  significant: Comment[];
}

const sourceText = (file: string, source: string, result: ParseResult, options: ParseOptions): SourceText => {
  // A package file changes only with the package, so its text can stay as it is.
  if (isInNodeModules(file)) return { clean: (_, start, end) => source.slice(start, end), significant: [] };
  const comments = result.comments ?? [];
  // JSDoc tags are types in a JavaScript file TypeScript checks.
  const jsdoc = JS_FILE.test(file) && (options.checkJs === true || comments.some(c => /@ts-check\b/.test(c.value)));
  const significant = comments.filter(c => isSignificant(c, jsdoc));
  return { clean: canonicalText(source, significant), significant };
};

export const parseModule = (file: string, source: string, options: ParseOptions = {}): ParseOutcome => {
  sawJsx = false;
  const result = parseSync(file, source, { sourceType: 'unambiguous' });
  const errors = result.errors.map(e => e.message);
  if (errors.length > 0) return { module: parseErrorFallback(source, result), errors };
  const pragmas = jsxPragmas(result);
  const runtime = pragmas.found.jsxRuntime;
  const classic =
    runtime === 'classic' ||
    (runtime !== 'automatic' && pragmas.found.jsxImportSource === undefined && (pragmas.found.jsx !== undefined || options.jsxClassic === true));
  jsxFactories = classic ? [pragmas.found.jsx ?? options.jsxFactory ?? 'React.createElement'] : undefined;
  jsxFragmentFactories = classic ? [pragmas.found.jsxFrag ?? options.jsxFragmentFactory ?? 'React.Fragment'] : undefined;
  try {
    const text = sourceText(file, source, result, options);
    return analyze(source, text, result, options, { classic, importSource: pragmas.found.jsxImportSource, text: pragmas.text });
  } catch (error) {
    // A stack overflow on pathological input: hash the whole file and keep its static imports.
    return { module: parseErrorFallback(source, result), errors: [`cannot analyze (${(error as Error).message})`] };
  } finally {
    jsxFactories = jsxFragmentFactories = undefined;
  }
};

const FRESH_VALUES = new Set(['ObjectExpression', 'ArrayExpression', 'ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression', 'NewExpression']);
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression']);

/** `const config = {}`: an object only this binding can reach, so `config.x = 1` belongs to it. */
const isFreshValue = (init: unknown): boolean => {
  let current = node(init);
  while (current && WRAPPERS.has(current.type)) current = node(current.expression);
  return current !== undefined && FRESH_VALUES.has(current.type);
};

/**
 * Packages whose calls only build values: a `cva()` or `z.object()` nobody uses can go.
 * A call into anything else may register, patch or subscribe, so it runs with the module.
 */
const PURE_SOURCES = /^(?:react|class-variance-authority|tailwind-variants|clsx|tailwind-merge|zod|valibot|yup|@sinclair\/typebox|arktype|styled-components|@emotion\/styled|@tanstack\/react-table|hono)(?:\/|$)/;
/** Globals whose calls build values. `Object.assign` and `Object.defineProperty` change their target. */
const PURE_GLOBALS = new Set([
  'Symbol', 'Object', 'Array', 'String', 'Number', 'Boolean', 'BigInt', 'Math', 'JSON', 'Date', 'RegExp', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'WeakRef', 'URL', 'URLSearchParams', 'Error', 'TypeError', 'RangeError', 'Intl', 'parseInt',
  'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'structuredClone', 'Uint8Array', 'TextEncoder', 'TextDecoder',
]);
const MUTATING_STATICS = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']);
/** `Array.prototype.push.call(list, x)`: a built-in reached this way changes its target. */
const BORROWING = new Set(['prototype', 'call', 'apply', 'bind']);
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration', 'TSDeclareFunction']);
const CLASSES = new Set(['ClassExpression', 'ClassDeclaration']);
const VALUE_WRAPPERS = new Set([...WRAPPERS, 'TSInstantiationExpression']);

/** What a top-level piece of code does while the module evaluates, outside function bodies. */
interface Eager {
  refs: Set<string>;
  /** Some call, `new`, assignment or `await` may do more than build a value. */
  impure: boolean;
}

const calleeRoot = (callee: unknown): N | undefined => {
  let current = node(callee);
  while (current) {
    if (current.type === 'MemberExpression') current = node(current.object);
    else if (current.type === 'CallExpression' || current.type === 'NewExpression') current = node(current.callee);
    else if (current.type === 'TaggedTemplateExpression') current = node(current.tag);
    else if (current.type === 'ChainExpression' || VALUE_WRAPPERS.has(current.type)) current = node(current.expression);
    else return current;
  }
};

/**
 * `library`: a call into a package that only builds values; function arguments are not run yet.
 * `builtin`: a built-in or a method of a literal, which may call its function arguments now.
 */
type Purity = 'library' | 'builtin' | false;

const eagerOf = (root: unknown, isPure: (call: N) => Purity, mayCall: (name: string) => boolean = () => true): Eager => {
  const eager: Eager = { refs: new Set(), impure: false };
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
      continue;
    }
    if (!isNode(value) || FUNCTIONS.has(value.type)) continue;
    if (value.type.startsWith('TS') && !VALUE_WRAPPERS.has(value.type) && value.type !== 'TSEnumDeclaration' && value.type !== 'TSEnumMember') continue;
    if (CLASSES.has(value.type)) {
      // A class body runs on definition only in its heritage, decorators, computed keys and static members.
      stack.push(value.superClass, value.decorators);
      for (const m of nodes(node(value.body)?.body)) {
        stack.push(m.decorators);
        if (m.computed) stack.push(m.key);
        if (m.type === 'StaticBlock') stack.push(m.body);
        else if (m.static && m.type !== 'MethodDefinition') stack.push(m.value);
      }
      continue;
    }
    switch (value.type) {
      case 'Identifier':
      case 'JSXIdentifier':
        eager.refs.add(value.name as string);
        continue;
      case 'MemberExpression':
        stack.push(value.object);
        if (value.computed) stack.push(value.property);
        continue;
      case 'AssignmentExpression':
      case 'UpdateExpression':
      case 'AwaitExpression':
      case 'YieldExpression':
      case 'ImportExpression':
        eager.impure = true;
        break;
      case 'UnaryExpression':
        if (value.operator === 'delete') eager.impure = true;
        break;
      case 'CallExpression':
      case 'NewExpression':
      case 'TaggedTemplateExpression': {
        const purity = isPure(value);
        if (!purity) {
          eager.impure = true;
          break;
        }
        // `[1].map(f)`, `JSON.parse(s, reviver)`, `'x'.replace(/x/, fn)`: the callback runs now.
        if (purity === 'builtin')
          for (const arg of nodes(value.arguments)) {
            if (FUNCTIONS.has(arg.type)) stack.push(arg.body);
            else if (arg.type === 'Identifier' && mayCall(arg.name as string)) eager.impure = true;
          }
        break;
      }
    }
    const keys = visitorKeys[value.type];
    if (!keys) continue;
    const skipKey = KEYED.has(value.type) && !value.computed;
    for (let i = keys.length - 1; i >= 0; i--) if (!(skipKey && keys[i] === 'key')) stack.push(value[keys[i]]);
  }
  return eager;
};

/** Index of the first non-space character at or after `pos`. */
const skipSpace = (source: string, pos: number) => {
  while (pos < source.length && isSpace(source.charCodeAt(pos))) pos++;
  return pos;
};

const analyze = (
  source: string,
  text: SourceText,
  result: ParseResult,
  options: ParseOptions,
  jsx: { classic: boolean; importSource?: string; text: string }
): ParseOutcome => {
  const program = result.program as unknown as N;
  const errors: string[] = [];
  if (!result.module.hasModuleSyntax) {
    const usage = newUsage();
    walk(program, usage);
    return {
      module: {
        kind: 'opaque',
        reason: 'commonjs',
        content: text.clean(program, 0, source.length),
        specifiers: [...usage.dynamic, ...usage.types],
        contexts: [...usage.contexts],
        paths: [...usage.paths],
        env: [...usage.env],
        jsx: sawJsx,
      },
      errors,
    };
  }

  /** Spans fragment text came from, so significant comments outside them can count on their own. */
  const spans: Array<{ start: number; end: number }> = [];
  const span = (n: N, start: number, end: number) => {
    spans.push({ start, end });
    return text.clean(n, start, end);
  };
  const slice = (n: N) => span(n, n.start, n.end);
  const imports = new Map<string, ImportBinding>();
  const exports = new Map<string, ExportEntry>();
  const stars: StarExport[] = [];
  const decls = new Map<string, Decl>();
  const requests: ModuleRequest[] = [];
  const effects: Array<{ pos: number; text: string; node?: N }> = [];
  /** Top-level code that runs on definition: initializers, class definitions, `export default` expressions. */
  const eager: Array<{ names: string[]; node: unknown; pos: number }> = [];
  /** Where each value binding is declared. Function declarations are hoisted, so their place does not matter. */
  const declared = new Map<string, { pos: number; hoisted: boolean }>();
  /** Local functions, which a built-in such as `forEach` may call. */
  /** Top-level functions by name, to read what a callback does when a built-in calls it. */
  const functions = new Map<string, N>();
  const place = (name: string, pos: number, hoisted: boolean) => {
    if (!declared.has(name)) declared.set(name, { pos, hoisted });
  };
  const effectUsage = newUsage();
  const typeEffects: string[] = [];
  const typeUsage = newUsage();
  const assigns: N[] = [];
  /** Bindings whose value is a function, class or literal object, which member assignments may extend. */
  const attachable = new Set<string>();
  const directives: string[] = [];
  let exportEquals = false;
  if (jsx.text) effects.push({ pos: -1, text: jsx.text });

  /** A class with decorators written before `export` starts at the first decorator. */
  const spanOf = (stmt: N, decl: N) => {
    const first = nodes(decl.decorators)[0];
    return first && first.start < stmt.start ? span(stmt, first.start, stmt.end) : slice(stmt);
  };

  /** Decorators and static blocks run when the class is defined, like top-level code (route registration, DI). */
  const classEffects = (stmt: N, decl: N, name: string) => {
    const members = nodes(node(decl.body)?.body);
    // `constructor(@Inject('a') a)`: parameter decorators run on definition too.
    const decoratedParams = (m: N) => nodes(node(m.value)?.params).some(p => nodes(p.decorators).length > 0);
    if (nodes(decl.decorators).length === 0 && !members.some(m => m.type === 'StaticBlock' || nodes(m.decorators).length > 0 || decoratedParams(m))) return;
    effects.push({ pos: stmt.start, text: `class ${name} runs on definition` });
    effectUsage.refs.add(name);
  };

  const declare = (names: string[], text: string, subtree: unknown) => {
    const usage = newUsage();
    walk(subtree, usage);
    let created: Decl | undefined;
    for (const name of names) {
      const existing = decls.get(name);
      if (existing) {
        existing.text += `\n${text}`;
        mergeUsage(existing.usage, usage);
      } else {
        created ??= { names, text, usage };
        decls.set(name, created);
      }
    }
  };

  const effect = (stmt: N) => {
    effects.push({ pos: stmt.start, text: slice(stmt), node: stmt });
    walk(stmt, effectUsage);
  };

  const exportLocal = (name: string, type: boolean) => exports.set(name, { name, local: name, type });

  const handleDeclaration = (decl: N, stmt: N, exported: boolean) => {
    switch (decl.type) {
      case 'VariableDeclaration': {
        const prefix = `${exported ? 'export ' : ''}${decl.declare ? 'declare ' : ''}${decl.kind as string} `;
        for (const declarator of nodes(decl.declarations)) {
          const names = bindingNames(declarator.id);
          declare(names, prefix + slice(declarator), declarator);
          for (const name of names) place(name, declarator.start, false);
          if (names.length === 1 && FUNCTIONS.has(node(declarator.init)?.type ?? '')) functions.set(names[0], node(declarator.init) as N);
          if (declarator.init && !decl.declare) eager.push({ names, node: declarator.init, pos: declarator.start });
          if (names.length === 1 && isFreshValue(declarator.init)) attachable.add(names[0]);
          if (exported) for (const name of names) exportLocal(name, false);
        }
        return;
      }
      case 'FunctionDeclaration':
      case 'TSDeclareFunction':
      case 'ClassDeclaration':
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSEnumDeclaration': {
        const name = nameOf(decl.id);
        declare([name], spanOf(stmt, decl), decl);
        if (decl.type === 'FunctionDeclaration') {
          place(name, stmt.start, true);
          functions.set(name, decl);
        }
        if ((decl.type === 'ClassDeclaration' || decl.type === 'TSEnumDeclaration') && !decl.declare) {
          place(name, stmt.start, false);
          eager.push({ names: [name], node: decl, pos: stmt.start });
        }
        if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') attachable.add(name);
        if (decl.type === 'ClassDeclaration') classEffects(stmt, decl, name);
        if (exported) exportLocal(name, decl.type === 'TSInterfaceDeclaration' || decl.type === 'TSTypeAliasDeclaration');
        return;
      }
      case 'TSModuleDeclaration': {
        const id = node(decl.id);
        if (id?.type === 'Identifier' && decl.kind !== 'global' && id.name !== 'global') {
          declare([id.name as string], slice(stmt), decl.body);
          if (exported) exportLocal(id.name as string, false);
        } else {
          typeEffects.push(slice(stmt));
          walk(stmt, typeUsage);
        }
        return;
      }
      case 'TSImportEqualsDeclaration': {
        const local = nameOf(decl.id);
        const reference = node(decl.moduleReference);
        const source = reference?.type === 'TSExternalModuleReference' ? staticString(reference.expression) : undefined;
        if (source !== undefined) {
          const type = decl.importKind === 'type';
          imports.set(local, { local, source, imported: '*', type, text: `import ${local} = require(${source})` });
          requests.push({ source, bare: false, type, named: false });
        } else declare([local], slice(stmt), reference);
        if (exported) exportLocal(local, false);
        return;
      }
      default:
        effect(stmt);
    }
  };

  for (const stmt of nodes(program.body)) {
    switch (stmt.type) {
      case 'ImportDeclaration': {
        const source = staticString(stmt.source) ?? '';
        const declType = stmt.importKind === 'type';
        const specifiers = nodes(stmt.specifiers);
        let named = specifiers.length > 0;
        let allType = declType || specifiers.length > 0;
        for (const s of specifiers) {
          const local = nameOf(s.local);
          const imported =
            s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : nameOf(s.imported);
          const type = declType || s.importKind === 'type';
          if (!type) allType = false;
          if (imported === 'default' || imported === '*') named = false;
          const binding = imported === '*' ? `* as ${local}` : imported === local ? local : `${imported} as ${local}`;
          imports.set(local, { local, source, imported, type, text: `import ${type ? 'type ' : ''}${binding} from ${source}` });
        }
        // With verbatimModuleSyntax, `import { type X } from './x'` compiles to `import {} from './x'`.
        requests.push({ source, bare: specifiers.length === 0, type: options.verbatimModuleSyntax ? declType : allType, named });
        // `import 'polyfill'` runs code and nothing else names it, so it is part of the module's effects.
        if (specifiers.length === 0 && !declType) effects.push({ pos: stmt.start, text: slice(stmt) });
        break;
      }
      case 'ExportNamedDeclaration': {
        const declaration = node(stmt.declaration);
        if (declaration) {
          handleDeclaration(declaration, stmt, true);
          break;
        }
        const source = staticString(stmt.source);
        const declType = stmt.exportKind === 'type';
        const specifiers = nodes(stmt.specifiers);
        let allType = declType || specifiers.length > 0;
        let named = specifiers.length > 0;
        for (const s of specifiers) {
          const exported = nameOf(s.exported);
          const local = nameOf(s.local);
          const type = declType || s.exportKind === 'type';
          if (!type) allType = false;
          if (local === 'default') named = false;
          const head = `export ${type ? 'type ' : ''}${local === exported ? local : `${local} as ${exported}`}`;
          exports.set(
            exported,
            source === undefined
              ? { name: exported, local, type, text: head }
              : { name: exported, source, imported: local, type, text: `${head} from ${source}` }
          );
        }
        if (source !== undefined) requests.push({ source, bare: false, type: options.verbatimModuleSyntax ? declType : allType, named });
        break;
      }
      case 'ExportDefaultDeclaration': {
        const declaration = node(stmt.declaration);
        if (!declaration) break;
        const id = node(declaration.id);
        if (
          id &&
          (declaration.type === 'FunctionDeclaration' ||
            declaration.type === 'ClassDeclaration' ||
            declaration.type === 'TSInterfaceDeclaration')
        ) {
          declare([id.name as string], spanOf(stmt, declaration), declaration);
          if (declaration.type === 'FunctionDeclaration') place(id.name as string, stmt.start, true);
          if (declaration.type === 'ClassDeclaration') {
            place(id.name as string, stmt.start, false);
            eager.push({ names: [id.name as string], node: declaration, pos: stmt.start });
          }
          if (declaration.type !== 'TSInterfaceDeclaration') attachable.add(id.name as string);
          if (declaration.type === 'ClassDeclaration') classEffects(stmt, declaration, id.name as string);
          exports.set('default', { name: 'default', local: id.name as string, type: declaration.type === 'TSInterfaceDeclaration' });
        } else if (declaration.type === 'Identifier') {
          const local = declaration.name as string;
          exports.set('default', { name: 'default', local, type: false, text: `export default ${local}` });
        } else {
          declare(['default'], spanOf(stmt, declaration), declaration);
          if (declaration.type !== 'FunctionDeclaration' && declaration.type !== 'TSDeclareFunction') eager.push({ names: ['default'], node: declaration, pos: stmt.start });
          if (declaration.type === 'ClassDeclaration') classEffects(stmt, declaration, 'default');
          exports.set('default', { name: 'default', local: 'default', type: false });
        }
        break;
      }
      case 'ExportAllDeclaration': {
        const source = staticString(stmt.source) ?? '';
        const type = stmt.exportKind === 'type';
        const exported = node(stmt.exported);
        const head = `export ${type ? 'type ' : ''}*`;
        if (exported) {
          const name = nameOf(exported);
          exports.set(name, { name, source, imported: '*', type, text: `${head} as ${name} from ${source}` });
        } else stars.push({ source, type, text: `${head} from ${source}` });
        requests.push({ source, bare: false, type, named: false });
        break;
      }
      case 'TSExportAssignment':
        exportEquals = true;
        declare(['default'], slice(stmt), stmt.expression);
        eager.push({ names: ['default'], node: stmt.expression, pos: stmt.start });
        exports.set('default', { name: 'default', local: 'default', type: false });
        break;
      case 'TSNamespaceExportDeclaration':
      case 'EmptyStatement':
        break;
      case 'ExpressionStatement': {
        if (typeof stmt.directive === 'string') {
          directives.push(stmt.directive);
          effects.push({ pos: stmt.start, text: slice(stmt) });
          break;
        }
        const expression = node(stmt.expression);
        const left = node(expression?.left);
        if (expression?.type === 'AssignmentExpression' && left?.type === 'MemberExpression') {
          assigns.push(stmt);
          break;
        }
        effect(stmt);
        break;
      }
      default:
        handleDeclaration(stmt, stmt, false);
    }
  }

  for (const stmt of assigns) {
    const root = rootIdentifier(node(node(stmt.expression)?.left) as N);
    // `Foo.displayName = 'Foo'` extends Foo. `root.dataset.theme = 'dark'` on `const root = document.documentElement`
    // changes the page, so it stays a side effect.
    const decl = root === undefined || imports.has(root) || !attachable.has(root) ? undefined : decls.get(root);
    if (decl) {
      decl.text += `\n${slice(stmt)}`;
      walk(stmt, decl.usage);
    } else effect(stmt);
  }

  // `/*#__PURE__*/ f()`: the annotation sits right before the call.
  const annotated = new Set<number>();
  for (const c of result.comments ?? []) if (/[@#]__PURE__/.test(c.value)) annotated.add(skipSpace(source, c.end));
  const borrows = (callee: unknown): boolean => {
    for (let current = node(callee); current?.type === 'MemberExpression'; current = node(current.object)) if (BORROWING.has(nameOf(current.property))) return true;
    return false;
  };
  const isPure = (call: N): Purity => {
    if (annotated.has(call.start)) return 'library';
    const callee = call.type === 'TaggedTemplateExpression' ? call.tag : call.callee;
    const root = calleeRoot(callee);
    if (!root) return false;
    if (root.type !== 'Identifier') {
      const literal = root.type === 'Literal' || root.type === 'TemplateLiteral' || root.type === 'ArrayExpression' || root.type === 'ObjectExpression';
      return literal && !borrows(callee) ? 'builtin' : false;
    }
    const name = root.name as string;
    const binding = imports.get(name);
    if (binding) return !binding.type && PURE_SOURCES.test(binding.source) ? 'library' : false;
    if (declared.has(name) || decls.has(name)) return false;
    const member = node(callee);
    if (member?.type === 'MemberExpression' && node(member.object) === root && MUTATING_STATICS.has(nameOf(member.property))) return false;
    return PURE_GLOBALS.has(name) && !borrows(callee) ? 'builtin' : false;
  };
  /**
   * Whether calling `name`, passed to a built-in that calls it, may do more than build a value:
   * an import from outside the pure libraries, or a local function whose parameters or body
   * may. A function that calls itself, or a declaration with no body, counts as impure.
   */
  const calling = new Set<string>();
  const mayCall = (name: string): boolean => {
    const binding = imports.get(name);
    if (binding) return binding.type || !PURE_SOURCES.test(binding.source);
    const fn = functions.get(name);
    if (!fn) return false;
    if (calling.has(name) || !fn.body || fn.async || fn.generator) return true;
    calling.add(name);
    try {
      return eagerOf([fn.params, fn.body], isPure, mayCall).impure;
    } finally {
      calling.delete(name);
    }
  };
  /** A binding that top-level code reads before or after its declaration: moving one past the other can throw. */
  const order = (refs: Set<string>, own: string[], pos: number) => {
    const marks: string[] = [];
    for (const ref of [...refs].sort()) {
      const at = declared.get(ref);
      if (!at || at.hoisted || own.includes(ref)) continue;
      marks.push(`${ref} ${at.pos < pos ? 'before' : 'after'}`);
    }
    return marks.length > 0 ? `\n/* order: ${marks.join(', ')} */` : '';
  };
  const ran = new Set(effects.filter(e => e.text.endsWith(' runs on definition')).map(e => e.text));
  for (const item of eager) {
    const found = eagerOf(item.node, isPure, mayCall);
    const decl = decls.get(item.names[0]);
    if (decl) decl.text += order(found.refs, item.names, item.pos);
    if (!found.impure) continue;
    // `export const store = createStore()` runs whenever the module does, used or not.
    const text = `${item.names.join(', ')} runs on definition`;
    if (ran.has(text) || ran.has(`class ${text}`)) continue;
    ran.add(text);
    effects.push({ pos: item.pos, text });
    for (const name of item.names) effectUsage.refs.add(name);
  }
  for (const e of effects) if (e.node) e.text += order(eagerOf(e.node, isPure, mayCall).refs, [], e.pos);

  // No fragment holds a `// @ts-expect-error` above an import or a `/*! license */` at the top.
  spans.sort((a, b) => a.start - b.start);
  let reach = -1;
  const covered: Array<{ start: number; end: number }> = [];
  for (const s of spans) {
    if (s.start < reach) covered[covered.length - 1].end = Math.max(reach, s.end);
    else covered.push({ ...s });
    reach = Math.max(reach, s.end);
  }
  const loose = text.significant.filter(c => {
    const i = firstFrom(covered, c.start + 1) - 1;
    return !(i >= 0 && c.end <= covered[i].end) && !JSX_PRAGMA_LINE.test(c.value);
  });
  if (loose.length > 0) effects.push({ pos: -1, text: loose.map(c => source.slice(c.start, c.end)).join('\n') });

  effects.sort((a, b) => a.pos - b.pos);
  return {
    module: {
      kind: 'esm',
      imports,
      exports,
      stars,
      decls,
      effects: { text: effects.map(e => e.text).join('\n'), usage: effectUsage, runs: effects.some(e => e.pos >= 0) },
      types: { text: typeEffects.join('\n'), usage: typeUsage },
      requests,
      exportEquals,
      directives,
      jsx: sawJsx,
      jsxClassic: jsx.classic,
      jsxImportSource: jsx.importSource,
    },
    errors,
  };
};

// `[ \t]*`, not `\s*`: under the `m` flag, `^\s*` retries from every line of a blank run (quadratic).
const MDX_IMPORT = /^[ \t]*(?:import|export)\s[^'";]{0,2000}?from\s*['"]([^'"]+)['"]|^[ \t]*import\s*['"]([^'"]+)['"]/gm;

/** MDX files are hashed whole; their `import` lines still extend the graph. */
export const mdxModule = (source: string): OpaqueModule => {
  const specifiers: string[] = [];
  for (const match of source.matchAll(MDX_IMPORT)) specifiers.push(match[1] ?? match[2]);
  return { kind: 'opaque', reason: 'mdx', content: source, specifiers, jsx: true };
};

/**
 * HTML comments, and `<script>` or `<style>` blocks. A comment matches first, so a `<script>` inside
 * `<!-- -->` is skipped. Attribute values are read as quoted strings, so `generic="T extends X<Y>"`
 * does not end the tag. Each alternative starts on a distinct character, so matching stays linear.
 */
const BLOCK = /<!--[\s\S]*?-->|<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>/gi;
/** `src="./logo.png"` in a template: Vue and Astro compile relative and aliased asset URLs to imports. */
const TEMPLATE_ASSET = /\s(?:src|href|xlink:href|poster|srcset)\s*=\s*(?:"([^"\n]{1,2000})"|'([^'\n]{1,2000})'|([^\s"'>]{1,2000}))/g;
const LOCAL_ASSET = /^(?:\.{1,2}\/|@\/|~\/)/;
/** Imports a script that does not parse still names, read off its text. */
const SCRIPT_IMPORT = /\b(?:import|export)\b[^'";]{0,2000}?\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*\(?\s*['"]([^'"\n]+)['"]/g;
const ATTRIBUTE = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');

export interface ComponentParts {
  /** Script blocks, with the extension to parse each one as. */
  scripts: Array<{ code: string; ext: string }>;
  /** Style blocks and their `lang`. */
  styles: Array<{ code: string; ext: string }>;
  /** Asset paths the template names. */
  assets: string[];
  /** `<script src>` and `<style src>`. */
  sources: string[];
}

/** The parts of a `.vue`, `.svelte` or `.astro` file byakugan follows. Astro's frontmatter is a script. */
export const componentParts = (file: string, source: string): ComponentParts => {
  const parts: ComponentParts = { scripts: [], styles: [], assets: [], sources: [] };
  const langExt = (attrs: string, fallback: string) => {
    const lang = ATTRIBUTE('lang').exec(attrs)?.[1]?.toLowerCase();
    return lang === 'tsx' || lang === 'jsx' ? '.tsx' : lang && /^(scss|sass|less|styl|stylus|postcss|css)$/.test(lang) ? `.${lang === 'postcss' ? 'css' : lang}` : fallback;
  };
  if (file.endsWith('.astro')) {
    const front = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (front) parts.scripts.push({ code: front[1], ext: '.ts' });
  }
  for (const m of source.matchAll(BLOCK)) {
    const [, tag, attrs = '', code = ''] = m;
    if (!tag) continue;
    const src = ATTRIBUTE('src').exec(attrs)?.[1];
    if (src) parts.sources.push(src);
    if (tag.toLowerCase() === 'style') {
      parts.styles.push({ code, ext: langExt(attrs, '.css') });
      continue;
    }
    // `<script type="application/ld+json">` and other data blocks are not code.
    const type = ATTRIBUTE('type').exec(attrs)?.[1];
    if (type && !/^(module|text\/javascript|text\/typescript|ts)$/i.test(type)) continue;
    // Svelte and Vue TypeScript is usual even without `lang="ts"`, and the TypeScript parser reads plain JavaScript.
    parts.scripts.push({ code, ext: langExt(attrs, '.ts') });
  }
  for (const m of source.matchAll(TEMPLATE_ASSET)) {
    // `srcset="./a.png 1x, ./b.png 2x"` lists several.
    for (const candidate of (m[1] ?? m[2] ?? m[3]).split(',')) {
      const path = candidate.trim().split(/\s+/)[0];
      if (LOCAL_ASSET.test(path)) parts.assets.push(path);
    }
  }
  return parts;
};

/**
 * A `.vue`, `.svelte` or `.astro` file: hashed whole, since its template uses its script in ways
 * byakugan does not read. Its scripts' imports count by imported name, so a barrel still splits.
 */
export const componentModule = (file: string, source: string, scripts: Array<{ module: ModuleInfo; code: string }>, styleSpecifiers: string[]): OpaqueModule => {
  const parts = componentParts(file, source);
  const imports: Array<{ source: string; name: string; type: boolean }> = [];
  const contexts = new Set<string>();
  const paths = new Set<string>();
  const env = new Set<string>();
  for (const { module: script, code } of scripts) {
    if (script.kind === 'opaque') {
      for (const s of script.specifiers) imports.push({ source: s, name: '*', type: false });
      // A script that does not parse may still import things; read them off its text.
      if (script.reason === 'parse-error') for (const m of code.matchAll(SCRIPT_IMPORT)) imports.push({ source: m[1] ?? m[2], name: '*', type: false });
      for (const e of script.env ?? []) env.add(e);
      continue;
    }
    for (const binding of script.imports.values()) imports.push({ source: binding.source, name: binding.imported, type: binding.type });
    for (const entry of script.exports.values()) if (entry.source) imports.push({ source: entry.source, name: entry.imported ?? '*', type: entry.type });
    for (const star of script.stars) imports.push({ source: star.source, name: '*', type: star.type });
    for (const request of script.requests) if (request.bare) imports.push({ source: request.source, name: '*', type: false });
    for (const usage of [script.effects.usage, ...[...script.decls.values()].map(d => d.usage)]) {
      for (const d of usage.dynamic) imports.push({ source: d, name: '*', type: false });
      for (const t of usage.types) imports.push({ source: t, name: '*', type: true });
      for (const c of usage.contexts) contexts.add(c);
      for (const p of usage.paths) paths.add(p);
      for (const e of usage.env) env.add(e);
    }
  }
  for (const s of [...parts.sources, ...parts.assets]) imports.push({ source: s, name: '*', type: false });
  return {
    kind: 'opaque',
    reason: 'component',
    content: source,
    specifiers: styleSpecifiers,
    imports,
    contexts: [...contexts],
    paths: [...paths],
    env: [...env],
    jsx: false,
  };
};
