import { parseSync, visitorKeys } from 'oxc-parser';

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
}

/**
 * - `rel`: a `./x.ext` string literal; relative to the file, then to the project.
 * - `file`, `cwd`: `new URL(x, import.meta.url)`, `join(__dirname, x)`, `join(process.cwd(), x)`.
 * - `file-tree`, `cwd-tree`: the same with a computed tail; the static part is a directory.
 * - `glob`: Vite `import.meta.glob` patterns joined by `\u0001`. `/` is the project root.
 */
export type PathKind = 'rel' | 'file' | 'cwd' | 'file-tree' | 'cwd-tree' | 'glob';

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
  /** Directives and top-level statements that run when the module is evaluated. */
  effects: { text: string; usage: Usage };
  /** `declare global { ... }` and `declare module 'x' { ... }`: types only, they never run. */
  types: { text: string; usage: Usage };
  requests: ModuleRequest[];
  /** `export = x` (TypeScript CommonJS export). */
  exportEquals: boolean;
  /** Module directives such as `use client` and `use server`. */
  directives: string[];
  jsx: boolean;
}

export interface OpaqueModule {
  kind: 'opaque';
  reason: 'commonjs' | 'asset' | 'parse-error' | 'mdx';
  content: string | Buffer;
  specifiers: string[];
  /** CommonJS only: see `Usage`. */
  contexts?: string[];
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

/**
 * Collects every name a subtree might refer to. It over-approximates on purpose:
 * shadowed locals and binding names count as references. For change detection a
 * false "used" costs a rebuild, a false "unused" costs a missed one.
 */
const walk = (value: unknown, usage: Usage): void => {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, usage);
    return;
  }
  if (!isNode(value)) return;
  const n = value;
  switch (n.type) {
    case 'Identifier':
    case 'JSXIdentifier':
      usage.refs.add(n.name as string);
      break;
    case 'MemberExpression': {
      const object = node(n.object);
      if (!n.computed && object?.type === 'Identifier') {
        addMember(usage, object.name as string, nameOf(n.property));
        return;
      }
      walk(n.object, usage);
      if (n.computed) walk(n.property, usage);
      return;
    }
    case 'JSXMemberExpression': {
      const object = node(n.object);
      if (object?.type === 'JSXIdentifier') addMember(usage, object.name as string, nameOf(n.property));
      else walk(n.object, usage);
      return;
    }
    case 'TSQualifiedName': {
      const left = node(n.left);
      if (left?.type === 'Identifier') addMember(usage, left.name as string, nameOf(n.right));
      else walk(n.left, usage);
      return;
    }
    case 'JSXOpeningElement':
    case 'JSXOpeningFragment':
      sawJsx = true;
      break;
    case 'JSXClosingElement':
    case 'JSXClosingFragment':
    case 'JSXNamespacedName':
    case 'MetaProperty':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'PrivateIdentifier':
      return;
    case 'JSXAttribute':
      walk(n.value, usage);
      return;
    case 'LabeledStatement':
      walk(n.body, usage);
      return;
    case 'TSEnumMember':
      walk(n.initializer, usage);
      return;
    case 'Literal':
      if (typeof n.value === 'string' && RELATIVE_FILE.test(n.value)) usage.paths.add(`rel\0${n.value}`);
      return;
    case 'TemplateLiteral': {
      const fixed = staticString(n);
      if (fixed !== undefined && RELATIVE_FILE.test(fixed)) usage.paths.add(`rel\0${fixed}`);
      break;
    }
    case 'ImportExpression': {
      const specifier = staticString(n.source);
      if (specifier !== undefined) usage.dynamic.add(specifier);
      else {
        usage.contexts.add(specifierPattern(n.source));
        walk(n.source, usage);
      }
      walk(n.options, usage);
      return;
    }
    case 'CallExpression': {
      const callee = node(n.callee);
      const args = nodes(n.arguments);
      if (callee?.type === 'Identifier' && callee.name === 'require' && args.length === 1) {
        const specifier = staticString(args[0]);
        if (specifier !== undefined) {
          usage.dynamic.add(specifier);
          return;
        }
        usage.contexts.add(specifierPattern(args[0]));
        break;
      }
      const path = joinedPath(n) ?? staticRoot(n);
      if (path !== undefined) usage.paths.add(path);
      const globs = globPatterns(n);
      if (globs?.length === 0) usage.contexts.add('*');
      else if (globs) usage.paths.add(`glob\0${globs.join(GLOB_SEPARATOR)}`);
      break;
    }
    case 'NewExpression': {
      const args = nodes(n.arguments);
      const target = args.length === 2 && nameOf(n.callee) === 'URL' && isImportMetaUrl(args[1]) ? staticString(args[0]) : undefined;
      if (target !== undefined && !/^[a-z][\w+.-]*:/i.test(target)) usage.paths.add(`file\0${target}`);
      break;
    }
    case 'TSImportType': {
      const specifier = staticString(n.source ?? n.argument);
      if (specifier !== undefined) usage.types.add(specifier);
      walk(n.typeArguments, usage);
      return;
    }
  }
  const keys = visitorKeys[n.type];
  if (!keys) return;
  const skipKey = KEYED.has(n.type) && !n.computed;
  for (const key of keys) {
    if (skipKey && key === 'key') continue;
    walk(n[key], usage);
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

export const parseModule = (file: string, source: string): ParseOutcome => {
  sawJsx = false;
  const result = parseSync(file, source, { sourceType: 'unambiguous' });
  const program = result.program as unknown as N;
  const errors = result.errors.map(e => e.message);
  if (errors.length > 0) return { module: parseErrorFallback(source, result), errors };

  if (!result.module.hasModuleSyntax) {
    const usage = newUsage();
    walk(program, usage);
    return {
      module: {
        kind: 'opaque',
        reason: 'commonjs',
        content: source,
        specifiers: [...usage.dynamic, ...usage.types],
        contexts: [...usage.contexts],
        paths: [...usage.paths],
        jsx: sawJsx,
      },
      errors,
    };
  }

  const slice = (n: N) => source.slice(n.start, n.end);
  const imports = new Map<string, ImportBinding>();
  const exports = new Map<string, ExportEntry>();
  const stars: StarExport[] = [];
  const decls = new Map<string, Decl>();
  const requests: ModuleRequest[] = [];
  const effects: Array<{ pos: number; text: string }> = [];
  const effectUsage = newUsage();
  const typeEffects: string[] = [];
  const typeUsage = newUsage();
  const assigns: N[] = [];
  const directives: string[] = [];
  let exportEquals = false;

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
    effects.push({ pos: stmt.start, text: slice(stmt) });
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
        declare([name], slice(stmt), decl);
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
        requests.push({ source, bare: specifiers.length === 0, type: allType, named });
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
        if (source !== undefined) requests.push({ source, bare: false, type: allType, named });
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
          declare([id.name as string], slice(stmt), declaration);
          exports.set('default', { name: 'default', local: id.name as string, type: declaration.type === 'TSInterfaceDeclaration' });
        } else if (declaration.type === 'Identifier') {
          const local = declaration.name as string;
          exports.set('default', { name: 'default', local, type: false, text: `export default ${local}` });
        } else {
          declare(['default'], slice(stmt), declaration);
          exports.set('default', { name: 'default', local: 'default', type: false });
        }
        break;
      }
      case 'ExportAllDeclaration': {
        const source = staticString(stmt.source) ?? '';
        const type = stmt.exportKind === 'type';
        const exported = node(stmt.exported);
        if (exported) {
          const name = nameOf(exported);
          exports.set(name, { name, source, imported: '*', type, text: `export * as ${name} from ${source}` });
        } else stars.push({ source, type, text: `export * from ${source}` });
        requests.push({ source, bare: false, type, named: false });
        break;
      }
      case 'TSExportAssignment':
        exportEquals = true;
        declare(['default'], slice(stmt), stmt.expression);
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
    const decl = root === undefined || imports.has(root) ? undefined : decls.get(root);
    if (decl) {
      decl.text += `\n${slice(stmt)}`;
      walk(stmt, decl.usage);
    } else effect(stmt);
  }

  effects.sort((a, b) => a.pos - b.pos);
  return {
    module: {
      kind: 'esm',
      imports,
      exports,
      stars,
      decls,
      effects: { text: effects.map(e => e.text).join('\n'), usage: effectUsage },
      types: { text: typeEffects.join('\n'), usage: typeUsage },
      requests,
      exportEquals,
      directives,
      jsx: sawJsx,
    },
    errors,
  };
};

const MDX_IMPORT = /^\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;

/** MDX files are hashed whole; their `import` lines still extend the graph. */
export const mdxModule = (source: string): OpaqueModule => {
  const specifiers: string[] = [];
  for (const match of source.matchAll(MDX_IMPORT)) specifiers.push(match[1] ?? match[2]);
  return { kind: 'opaque', reason: 'mdx', content: source, specifiers, jsx: true };
};
