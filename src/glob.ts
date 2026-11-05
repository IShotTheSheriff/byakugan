import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';

// Globs come from the repository: byakugan.json, `import.meta.glob`, `sideEffects`. picomatch turns
// each one into a single regex, and a pattern such as `*a*a*a/*a*a*a/*a*a*ab` backtracks across
// segments for minutes. So braces are expanded first, then paths are matched one segment at a
// time. A segment of literals and `*` needs no regex; any other segment with many wildcards is
// widened to `*`, a superset.

const posix = (path: string) => (sep === '/' ? path : path.split(sep).join('/'));
const GLOB_CHARS = /[*?[\]{}()!+@]/;
const STAR_ONLY = /^[^?[\]{}()!+@\\]*$/;
const MAX_EXPANSIONS = 1024;

/** Exact for a segment of literals and `*`, in linear time. */
const starMatcher = (pattern: string) => {
  const parts = pattern.split('*');
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

const stars = (segment: string) => segment.match(/\*/g)?.length ?? 0;

/** A segment with more than two wildcards, or an extglob, widened to `*` (a superset). */
const tameSegment = (segment: string) => (segment !== '**' && (stars(segment) > 2 || /[*+?@!]\(/.test(segment)) ? '*' : segment);

/** The pattern with each risky segment widened to `*`. Matches everything the pattern matches. */
export const tameGlob = (pattern: string) => pattern.split('/').map(tameSegment).join('/');

/** Splits `a,{b,c},d` at top-level commas. */
const splitAlternatives = (body: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') i++;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
};

/**
 * `app/**\/{page,layout}.{ts,tsx}` as four patterns. Undefined when it would make more than
 * MAX_EXPANSIONS, so `{a,b}{a,b}{a,b}...` cannot blow up. Ranges like `{1..3}` stay for picomatch.
 */
const expandBraces = (pattern: string): string[] | undefined => {
  const out: string[] = [];
  const queue = [pattern];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    let depth = 0;
    let open = -1;
    let expanded = false;
    for (let i = 0; i < current.length && !expanded; i++) {
      const c = current[i];
      if (c === '\\') i++;
      else if (c === '{') {
        if (depth === 0) open = i;
        depth++;
      } else if (c === '}' && depth > 0 && --depth === 0) {
        const alternatives = splitAlternatives(current.slice(open + 1, i));
        if (alternatives.length < 2) continue;
        for (const alternative of alternatives) queue.push(current.slice(0, open) + alternative + current.slice(i + 1));
        expanded = true;
      }
    }
    if (!expanded) out.push(current);
    if (out.length + queue.length > MAX_EXPANSIONS) return;
  }
  return out;
};

/** `.` and `..` match only themselves, as in picomatch, even with `dot`. */
const relativeSegment = (s: string) => s === '.' || s === '..';

/** A segment picomatch would match in more than linear time, which `segmentMatcher` widens to `*`. */
const widens = (segment: string) => GLOB_CHARS.test(segment) && !STAR_ONLY.test(segment) && tameSegment(segment) !== segment;

const segmentMatcher = (segment: string, dot: boolean): ((s: string) => boolean) => {
  if (!GLOB_CHARS.test(segment)) return s => s === segment;
  if (STAR_ONLY.test(segment)) {
    const match = starMatcher(segment);
    return s => !relativeSegment(s) && (dot || !s.startsWith('.') || segment.startsWith('.')) && match(s);
  }
  // Widened to `*`, dot names included: a superset.
  if (widens(segment)) return s => !relativeSegment(s);
  const match = picomatch(segment, { dot });
  return s => !relativeSegment(s) && match(s);
};

/**
 * One brace-free pattern, matched segment by segment. `**` takes any number of segments. Each
 * part is one pass over the path, so a pattern of k parts costs k * n on a path of n segments.
 */
const compileExpanded = (pattern: string, dot: boolean): ((segments: string[]) => boolean) => {
  const raw = pattern.split('/').filter((p, i, all) => !(p === '**' && all[i - 1] === '**'));
  const parts = raw.map(p => (p === '**' ? null : segmentMatcher(p, dot)));
  const last = parts[parts.length - 1];
  return (segments: string[]) => {
    const n = segments.length;
    // Most paths fail on the file name: check it before walking the rest.
    if (last && !last(segments[n - 1])) return false;
    let at = new Uint8Array(n + 1);
    at[0] = 1;
    for (const part of parts) {
      const next = new Uint8Array(n + 1);
      let any = false;
      if (part === null) {
        // `**` does not cross `.`, `..` or, unless `dot` is set, dot segments.
        let reach = false;
        for (let j = 0; j <= n; j++) {
          if (at[j]) reach = true;
          if (reach) {
            next[j] = 1;
            any = true;
          }
          if (j < n && (relativeSegment(segments[j]) || (!dot && segments[j].startsWith('.')))) reach = false;
        }
      } else {
        for (let i = 0; i < n; i++) {
          if (at[i] && part(segments[i])) {
            next[i + 1] = 1;
            any = true;
          }
        }
      }
      if (!any) return false;
      at = next;
    }
    return at[n] === 1;
  };
};

/**
 * A pattern with too many brace expansions, widened to one without braces: each group becomes `*`,
 * or the pattern becomes `prefix/**` when a group holds a `/`. A superset either way.
 */
const widenBraces = (pattern: string): string => {
  let out = '';
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      if (depth === 0) out += c + (pattern[i + 1] ?? '');
      i++;
    } else if (c === '{') {
      if (depth++ === 0) out += '*';
    } else if (c === '}' && depth > 0) depth--;
    else if (depth === 0) out += c;
    else if (c === '/') {
      const prefix = staticPrefix(pattern);
      return prefix === '' ? '**' : `${prefix}/**`;
    }
  }
  return out;
};

/**
 * Every pattern, brace-expanded, as one test on a path's segments. Expansions whose file name is
 * literal (`page.tsx` from `app/**\/page.{tsx,jsx}`) are looked up by the path's file name, so
 * Next.js route globs, about 270 expansions, cost one map lookup per path.
 *
 * Widening makes a superset, which is safe for a pattern that includes and wrong for one that
 * excludes: `exact` drops every expansion that would need it, so an exclusion never drops more
 * than picomatch would.
 */
const compileAll = (patterns: string[], dot: boolean, exact = false): ((segments: string[]) => boolean) => {
  const byName = new Map<string, Array<(segments: string[]) => boolean>>();
  const rest: Array<(segments: string[]) => boolean> = [];
  for (const pattern of patterns) {
    const body = pattern.replace(/^\.\//, '');
    const expanded = expandBraces(body);
    if (!expanded && exact) continue;
    for (const one of expanded ?? [widenBraces(body)]) {
      if (exact && one.split('/').some(widens)) continue;
      const name = one.slice(one.lastIndexOf('/') + 1);
      // A widened pattern takes dot names too, so it stays a superset with `dot` off.
      const match = compileExpanded(one, dot || !expanded);
      if (name === '**' || GLOB_CHARS.test(name)) rest.push(match);
      else byName.set(name, [...(byName.get(name) ?? []), match]);
    }
  }
  return segments => (byName.get(segments[segments.length - 1])?.some(m => m(segments)) ?? false) || rest.some(m => m(segments));
};

/**
 * `(path) => boolean` for `/`-separated paths, like `picomatch(patterns)`, in time linear in the
 * path length. `!` patterns exclude.
 */
export const globMatcher = (patterns: string[], options: { dot?: boolean } = {}): ((path: string) => boolean) => {
  const dot = options.dot ?? false;
  const positive = compileAll(patterns.filter(p => !p.startsWith('!')), dot);
  const negative = compileAll(
    patterns.filter(p => p.startsWith('!')).map(p => p.slice(1)),
    dot,
    true
  );
  return (path: string) => {
    const segments = path.split('/');
    return positive(segments) && !negative(segments);
  };
};

const insideOf = (boundary: string, path: string) => path === boundary || path.startsWith(boundary + sep);

/** More directories than this reached through symlinks in one crawl stop the run, so links cannot make it quadratic. */
const MAX_LINKED_DIRS = 200_000;

interface CrawlOptions {
  boundary: string;
  skipDir: (name: string) => boolean;
  /** Under a pattern's fixed directories (`public/x` for `public/**`): such links go first. */
  wanted: (file: string) => boolean;
  /** Whether `a` and `b` are both under one `dir/**` pattern, which lists every file under them. */
  sameTree: (a: string, b: string) => boolean;
  /** The `dir/**` pattern `file` is under, or '' for none. */
  tree: (file: string) => string;
}

/**
 * Every entry under `root` that is not a directory, files and FIFOs alike (readers check the
 * type). Symlinked directories are followed only when their real path stays inside `boundary`,
 * so a committed `root -> /` link does not walk the disk. Plain directories come first, then the
 * links, wanted ones first and then shortest target first.
 *
 * A link is listed itself, and not entered, when its target's files are listed already under a
 * path that one `dir/**` pattern covers together with the link: `public/v2 -> v1` under
 * `public/**`. Readers hash such a link by its target, so adding, removing and retargeting it
 * count, and edits count through the target's own files. Any other link is entered, at most once
 * per target and `dir/**` pattern. That ends loops and keeps nested links from listing a file
 * once per link above it.
 */
const crawl = (root: string, options: CrawlOptions): string[] => {
  const { boundary, skipDir, wanted, sameTree, tree } = options;
  const out: string[] = [];
  let real: string;
  try {
    real = realpathSync(root);
    if (!statSync(real).isDirectory()) return out;
  } catch {
    return out;
  }
  if (!insideOf(boundary, real)) return out;
  /** Real directories entered, each with the paths it was listed under. */
  const roots = new Map<string, string[]>();
  const entered = new Set<string>();
  let linkedDirs = 0;
  /** The paths `target`'s files are listed under already, through any root above it. */
  const listedAs = (target: string): string[] => {
    const paths: string[] = [];
    for (let dir = target; insideOf(boundary, dir); dir = dirname(dir)) {
      const rest = relative(dir, target);
      if (rest !== '' && rest.split(sep).some(skipDir)) break;
      for (const path of roots.get(dir) ?? []) paths.push(join(path, rest));
      if (dirname(dir) === dir) break;
    }
    return paths;
  };
  let links: Array<[path: string, real: string, wanted: boolean]> = [];
  const enter = (start: string, startReal: string) => {
    roots.set(startReal, [...(roots.get(startReal) ?? []), start]);
    entered.add(`${startReal}\0${tree(start)}`);
    const stack: Array<[path: string, real: string]> = [[start, startReal]];
    const viaLink = start !== root;
    while (stack.length > 0) {
      const [dir, dirReal] = stack.pop() as [string, string];
      if (viaLink && ++linkedDirs > MAX_LINKED_DIRS) throw new Error(`${root}: more than ${MAX_LINKED_DIRS} directories reached through symlinks`);
      let entries;
      try {
        // Sorted, so the same tree lists the same way on every file system.
        entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch {
        continue;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          const childReal = join(dirReal, entry.name);
          // Reached again through a link to a directory above it.
          if (!skipDir(entry.name) && !roots.has(childReal)) stack.push([path, childReal]);
          continue;
        }
        if (entry.isSymbolicLink()) {
          try {
            const target = realpathSync(path);
            if (statSync(target).isDirectory()) {
              if (skipDir(entry.name)) continue;
              if (insideOf(boundary, target)) {
                links.push([path, target, wanted(path)]);
                continue;
              }
              // Outside the boundary: listed, not entered, so readers report it.
            }
          } catch {
            // A dangling link: listed, so readers can report it.
          }
        }
        out.push(path);
      }
    }
  };
  enter(root, real);
  while (links.length > 0) {
    const batch = links.sort((a, b) => Number(b[2]) - Number(a[2]) || a[1].length - b[1].length);
    links = [];
    for (const [path, target] of batch) {
      if (entered.has(`${target}\0${tree(path)}`) || listedAs(target).some(other => sameTree(path, other))) {
        out.push(path);
        continue;
      }
      enter(path, target);
    }
  }
  return out;
};

export interface GlobOptions {
  cwd: string;
  /** Fixed ignore globs (byakugan's own, never from the repository). `**\/name/**` skips a directory. */
  ignore?: string[];
  dot?: boolean;
  /** Directory the crawl must not leave through a symlink. Default: `cwd`. */
  boundary?: string;
}

/** The directory a pattern can match under: its segments before the first glob character. */
export const staticPrefix = (pattern: string) => {
  const segments = pattern.split('/');
  const index = segments.findIndex(s => GLOB_CHARS.test(s));
  return index === -1 ? segments.join('/') : segments.slice(0, index).join('/');
};

/** Files under `cwd` matching `patterns` (`!` excludes), as absolute paths. */
export const safeGlob = (patterns: string[], options: GlobOptions): string[] => {
  const { cwd } = options;
  const dot = options.dot ?? false;
  const boundary = options.boundary ?? cwd;
  const ignore = options.ignore ?? [];
  const skipNames = new Set(ignore.map(p => /^\*\*\/([^/*?[\]{}]+)\/\*\*$/.exec(p)?.[1]).filter((n): n is string => n !== undefined));
  const ignoreFile = globMatcher(ignore.filter(p => !/^\*\*\/[^/*?[\]{}]+\/\*\*$/.test(p)), { dot: true });
  const matches = globMatcher(patterns, { dot });
  // Shortest prefix first: a crawl of `.` makes a later crawl of `src` unnecessary.
  const positive = patterns
    .filter(p => !p.startsWith('!'))
    .map(p => p.replace(/^\.\//, ''))
    .sort((a, b) => staticPrefix(a).length - staticPrefix(b).length);
  const prefixes = positive.map(staticPrefix).filter(p => p !== '');
  const rel = (file: string) => posix(relative(cwd, file));
  const under = (path: string, dir: string) => dir === '' || path === dir || path.startsWith(`${dir}/`);
  const wanted = (file: string) => prefixes.some(p => under(rel(file), p));
  // `public/**` and `**`: patterns that list every file under a directory.
  const trees = positive.flatMap(p => (p === '**' ? [''] : /^[^*?[\]{}()!+@\\]+\/\*\*$/.test(p) ? [p.slice(0, -3)] : []));
  const tree = (file: string) => trees.filter(t => under(rel(file), t)).sort((a, b) => b.length - a.length)[0] ?? '\0';
  const sameTree = (a: string, b: string) => trees.some(t => under(rel(a), t) && under(rel(b), t));
  const found = new Set<string>();
  const crawled = new Set<string>();
  for (const pattern of positive) {
    const prefix = staticPrefix(pattern);
    const base = resolve(cwd, prefix);
    if (prefix === pattern) {
      // No glob characters: one path to check.
      try {
        if (!lstatSync(base).isDirectory()) found.add(base);
      } catch {}
      continue;
    }
    if ([...crawled].some(c => insideOf(c, base))) continue;
    crawled.add(base);
    for (const file of crawl(base, { boundary, skipDir: name => skipNames.has(name), wanted, sameTree, tree })) found.add(file);
  }
  return [...found].filter(file => {
    const path = posix(relative(cwd, file));
    return matches(path) && !ignoreFile(path);
  });
};
