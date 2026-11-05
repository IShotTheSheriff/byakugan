/**
 * Installs per package name: identity -> the version shown in reports. The identity adds what can
 * differ between two installs of one version number: the integrity hash, a git commit, a patch.
 */
export type Versions = Map<string, Map<string, string>>;

export const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']);

const add = (versions: Versions, name: string, version: string, identity = version) => {
  let installs = versions.get(name);
  if (!installs) {
    installs = new Map();
    versions.set(name, installs);
  }
  installs.set(identity, version);
};

interface NpmEntry {
  version?: string;
  name?: string;
  link?: boolean;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, unknown>;
}

const npm = (text: string): Versions => {
  const json = JSON.parse(text) as { packages?: Record<string, NpmEntry>; dependencies?: Record<string, NpmEntry> };
  const versions: Versions = new Map();
  if (json.packages) {
    for (const [path, entry] of Object.entries(json.packages)) {
      const at = path.lastIndexOf('node_modules/');
      if (at === -1 || entry.link || !entry.version) continue;
      add(versions, entry.name ?? path.slice(at + 'node_modules/'.length), entry.version, `${entry.version} ${entry.integrity ?? entry.resolved ?? ''}`);
    }
    return versions;
  }
  const walk = (deps: Record<string, NpmEntry> | undefined) => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      if (entry.version) add(versions, name, entry.version, `${entry.version} ${entry.integrity ?? entry.resolved ?? ''}`);
      walk(entry.dependencies as Record<string, NpmEntry> | undefined);
    }
  };
  walk(json.dependencies);
  return versions;
};

/**
 * `lodash@4.17.21(patch_hash=abc)` (v6+, leading `/` before v9) or `/lodash/4.17.21` (v5).
 * The full key is the identity: it carries peer suffixes, patch hashes and tarball URLs.
 */
const pnpmKey = (raw: string, major: number): { name: string; version: string } | undefined => {
  const key = raw.startsWith('/') ? raw.slice(1) : raw;
  if (major < 6) {
    const parts = key.split('/');
    const scoped = key.startsWith('@');
    if (parts.length < (scoped ? 3 : 2)) return;
    return scoped ? { name: `${parts[0]}/${parts[1]}`, version: parts.slice(2).join('/') } : { name: parts[0], version: parts.slice(1).join('/') };
  }
  const at = key.indexOf('@', 1);
  if (at === -1) return;
  return { name: key.slice(0, at), version: key.slice(at + 1).replace(/\(.*$/, '') };
};

/** `  key: value` two spaces in. Keys holding `:` (tarball URLs) may be quoted or not. */
const yamlKey = (line: string): { key: string; value: string } | undefined => {
  if (!/^ {2}\S/.test(line)) return;
  const body = line.slice(2);
  if (body[0] === "'" || body[0] === '"') {
    const end = body.indexOf(body[0], 1);
    if (end === -1 || body[end + 1] !== ':') return;
    return { key: body.slice(1, end), value: body.slice(end + 2).trim() };
  }
  const colon = /:(\s|$)/.exec(body);
  return colon ? { key: body.slice(0, colon.index), value: body.slice(colon.index + 1).trim() } : undefined;
};

const pnpm = (text: string): Versions => {
  const versions: Versions = new Map();
  const major = Number(/^lockfileVersion:\s*['"]?(\d+)/m.exec(text)?.[1] ?? 9);
  let section = '';
  let current: { name: string; version: string; key: string } | undefined;
  // A git dependency is keyed by its URL (`github.com/kevva/is-positive/97edff6:`) and named by
  // its `name:` field. The key has the commit, so it is the identity.
  let fields: { key: string; name?: string; version?: string } | undefined;
  const flush = () => {
    if (fields?.name && fields.name !== current?.name) add(versions, fields.name, fields.version ?? fields.key, fields.key);
    fields = undefined;
  };
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      flush();
      section = line.replace(/:.*$/, '');
      current = undefined;
      continue;
    }
    const entry = yamlKey(line);
    if (entry) {
      flush();
      const parsed = pnpmKey(entry.key, major);
      current = parsed ? { ...parsed, key: entry.key } : undefined;
      if (section === 'packages') fields = { key: entry.key };
      if (!parsed) continue;
      if (section === 'packages' || section === 'snapshots') add(versions, parsed.name, parsed.version, entry.key);
      // `patchedDependencies:` maps `lodash@4.17.21` to a hash (or, before v9, to the patch path).
      else if (section === 'patchedDependencies' && entry.value) add(versions, parsed.name, parsed.version, `patch ${entry.value}`);
      continue;
    }
    const own = fields && /^ {4}(name|version):\s*['"]?([^'"\s]+)/.exec(line);
    if (own && fields) fields[own[1] as 'name' | 'version'] = own[2];
    const field = /^ {4}(resolution|hash):\s*(.+)$/.exec(line);
    if (field && current && (section === 'packages' || section === 'patchedDependencies')) {
      add(versions, current.name, current.version, `${current.key} ${field[1]} ${field[2].trim()}`);
    }
  }
  flush();
  return versions;
};

const yarn = (text: string): Versions => {
  const versions: Versions = new Map();
  let names: string[] = [];
  let version: string | undefined;
  let details: string[] = [];
  const flush = () => {
    if (version) for (const name of new Set(names)) add(versions, name, version, [version, ...details].join(' '));
  };
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      flush();
      names = [];
      version = undefined;
      details = [];
      for (const raw of line.replace(/:$/, '').split(',')) {
        const entry = raw.trim().replace(/^"|"$/g, '');
        const at = entry.indexOf('@', 1);
        if (at <= 0 || entry.startsWith('__')) continue;
        // `my-lodash@npm:lodash@^4`: installed as an alias, but the package is lodash.
        const alias = /^npm:((?:@[^@/]+\/)?[^@]+)@/.exec(entry.slice(at + 1));
        names.push(alias ? alias[1] : entry.slice(0, at));
      }
      continue;
    }
    const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (v) {
      version = v[1];
      continue;
    }
    // v1 `resolved` and `integrity`, berry `resolution` and `checksum`: a git commit or patch hash lives here.
    const detail = /^\s+(resolved|integrity|resolution|checksum):?\s+"?([^"\s]+)"?/.exec(line);
    if (detail) details.push(detail[2]);
  }
  flush();
  return versions;
};

// `[ \t]*`, not `\s*`: under the `m` flag, `^\s*` retries from every line of a blank run (quadratic).
const BUN_ENTRY = /^[ \t]*"[^"\n]+":[ \t]*\[[ \t]*"((?:@[^@"/\n]+\/)?[^@"\n]+)@([^"\n]+)"([^\n]*)/gm;

/** The rest of the entry line holds the integrity hash: it is part of the identity. */
const bun = (text: string): Versions => {
  const versions: Versions = new Map();
  for (const match of text.matchAll(BUN_ENTRY)) add(versions, match[1], match[2], `${match[2]}${match[3]}`);
  return versions;
};

/**
 * Undefined when the format is unknown or unparseable (binary `bun.lockb`, corrupt files), or when
 * a lockfile with content yields no packages: an unknown layout must not read as "nothing changed".
 */
export const parseLockfile = (fileName: string, text: string): Versions | undefined => {
  let versions: Versions | undefined;
  try {
    if (fileName === 'package-lock.json' || fileName === 'npm-shrinkwrap.json') versions = npm(text);
    else if (fileName === 'pnpm-lock.yaml') versions = pnpm(text);
    else if (fileName === 'yarn.lock') versions = yarn(text);
    else if (fileName === 'bun.lock') versions = bun(text);
  } catch {
    return;
  }
  return versions && versions.size > 0 ? versions : undefined;
};

export interface VersionChange {
  name: string;
  before: string[];
  after: string[];
}

export const diffVersions = (before: Versions, after: Versions): VersionChange[] => {
  const changes: VersionChange[] = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(name) ?? new Map<string, string>();
    const b = after.get(name) ?? new Map<string, string>();
    if ([...a.keys()].sort().join('\n') === [...b.keys()].sort().join('\n')) continue;
    changes.push({ name, before: [...new Set(a.values())].sort(), after: [...new Set(b.values())].sort() });
  }
  return changes.sort((x, y) => x.name.localeCompare(y.name));
};
