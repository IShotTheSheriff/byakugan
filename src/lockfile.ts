/** Installed versions per package name, read from a lockfile. */
export type Versions = Map<string, Set<string>>;

export const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']);

const add = (versions: Versions, name: string, version: string) => {
  const set = versions.get(name);
  if (set) set.add(version);
  else versions.set(name, new Set([version]));
};

const npm = (text: string): Versions => {
  const json = JSON.parse(text) as {
    packages?: Record<string, { version?: string; name?: string; link?: boolean }>;
    dependencies?: Record<string, unknown>;
  };
  const versions: Versions = new Map();
  if (json.packages) {
    for (const [path, entry] of Object.entries(json.packages)) {
      const at = path.lastIndexOf('node_modules/');
      if (at === -1 || entry.link || !entry.version) continue;
      add(versions, entry.name ?? path.slice(at + 'node_modules/'.length), entry.version);
    }
    return versions;
  }
  const walk = (deps: Record<string, unknown> | undefined) => {
    for (const [name, value] of Object.entries(deps ?? {})) {
      const entry = value as { version?: string; dependencies?: Record<string, unknown> };
      if (entry.version) add(versions, name, entry.version);
      walk(entry.dependencies);
    }
  };
  walk(json.dependencies);
  return versions;
};

const PNPM_KEY = /^ {2}['"]?\/?((?:@[^@/\s'"]+\/)?[^@/\s'"(]+)@([^@(:\s'"]+)/gm;

const pnpm = (text: string): Versions => {
  const versions: Versions = new Map();
  for (const match of text.matchAll(PNPM_KEY)) add(versions, match[1], match[2]);
  return versions;
};

const yarn = (text: string): Versions => {
  const versions: Versions = new Map();
  let names: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      names = [];
      for (const raw of line.replace(/:$/, '').split(',')) {
        const entry = raw.trim().replace(/^"|"$/g, '');
        const at = entry.indexOf('@', 1);
        if (at > 0 && !entry.startsWith('__')) names.push(entry.slice(0, at));
      }
      continue;
    }
    const version = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (version) for (const name of new Set(names)) add(versions, name, version[1]);
  }
  return versions;
};

const BUN_ENTRY = /^\s*"[^"]+":\s*\[\s*"((?:@[^@"/]+\/)?[^@"]+)@([^"]+)"/gm;

const bun = (text: string): Versions => {
  const versions: Versions = new Map();
  for (const match of text.matchAll(BUN_ENTRY)) add(versions, match[1], match[2]);
  return versions;
};

/** Undefined when the format is unknown or unparseable (binary `bun.lockb`, corrupt files). */
export const parseLockfile = (fileName: string, text: string): Versions | undefined => {
  try {
    if (fileName === 'package-lock.json' || fileName === 'npm-shrinkwrap.json') return npm(text);
    if (fileName === 'pnpm-lock.yaml') return pnpm(text);
    if (fileName === 'yarn.lock') return yarn(text);
    if (fileName === 'bun.lock') return bun(text);
  } catch {
    return;
  }
};

export interface VersionChange {
  name: string;
  before: string[];
  after: string[];
}

export const diffVersions = (before: Versions, after: Versions): VersionChange[] => {
  const changes: VersionChange[] = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const a = [...(before.get(name) ?? [])].sort();
    const b = [...(after.get(name) ?? [])].sort();
    if (a.join() !== b.join()) changes.push({ name, before: a, after: b });
  }
  return changes.sort((x, y) => x.name.localeCompare(y.name));
};
