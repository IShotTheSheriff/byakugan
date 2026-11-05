import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Settings that keep repository contents from running code through git. A committed directory
 * laid out as a bare repository (HEAD, objects/, refs/, config) would otherwise be discovered
 * from inside it, and its `core.fsmonitor` command run.
 */
const SAFE = ['-c', 'safe.bareRepository=explicit', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];
const MAX_BUFFER = 1024 * 1024 * 1024;

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', [...SAFE, ...args], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });

export const gitRoot = (cwd: string): string | undefined => {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return;
  }
};

/** The merge base of `base` and HEAD. `exact` is false when there is none (a shallow clone) and `base` itself is used. */
export const mergeBase = (cwd: string, base: string): { commit: string; exact: boolean } => {
  // `--base=--independent` would otherwise reach git as an option.
  if (base.startsWith('-')) throw new Error(`"${base}" is not a git ref`);
  try {
    return { commit: git(cwd, ['merge-base', base, 'HEAD']).trim(), exact: true };
  } catch {
    return { commit: git(cwd, ['rev-parse', '--verify', `${base}^{commit}`]).trim(), exact: false };
  }
};

export interface FileChange {
  status: 'A' | 'M' | 'D';
  /** Path relative to the git root, with forward slashes. */
  path: string;
  /** Base and working-tree modes from `git diff --raw`: `120000` is a symlink, `160000` a submodule. */
  modes: string[];
}

/** Changes between `commit` and the working tree, untracked files included. Renames count as delete + add. */
export const changedFiles = (root: string, commit: string): FileChange[] => {
  const changes: FileChange[] = [];
  // `ignore = all` in .gitmodules would hide a submodule moved to another commit.
  const parts = git(root, ['diff', '--raw', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', '-z', commit]).split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [before, after, , , status] = parts[i].replace(/^:/, '').split(' ');
    const code = status?.[0];
    changes.push({ status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M', path: parts[i + 1], modes: [before, after] });
  }
  for (const path of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (path) changes.push({ status: 'A', path, modes: [] });
  }
  return changes;
};

/** File contents at `commit`, or undefined when the file did not exist there. */
export const showFile = (root: string, commit: string, path: string): Buffer | undefined => {
  try {
    return execFileSync('git', [...SAFE, 'show', `${commit}:${path}`], { cwd: root, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return;
  }
};

/** Contents at `commit` of many files with one `git cat-file --batch`. Missing files and submodules map to undefined. */
export const showFiles = (root: string, commit: string, paths: string[]): Map<string, Buffer | undefined> => {
  const out = new Map<string, Buffer | undefined>();
  // The batch protocol is line-based, and it drops a CR at the end of a line.
  const lineSafe = (p: string) => !p.includes('\n') && !p.includes('\r');
  const batch = paths.filter(lineSafe);
  for (const path of paths) if (!lineSafe(path)) out.set(path, showFile(root, commit, path));
  if (batch.length === 0) return out;
  const result = spawnSync('git', [...SAFE, 'cat-file', '--batch'], {
    cwd: root,
    input: batch.map(p => `${commit}:${p}\n`).join(''),
    maxBuffer: MAX_BUFFER,
  });
  if (result.status !== 0 || !result.stdout) {
    for (const path of batch) out.set(path, showFile(root, commit, path));
    return out;
  }
  const data = result.stdout;
  let pos = 0;
  for (const path of batch) {
    const newline = data.indexOf(10, pos);
    if (newline === -1) break;
    // `<sha> <type> <size>` for an object. A `missing` line echoes the request, spaces and all.
    const header = /^[0-9a-f]{40,64} (\w+) (\d+)$/.exec(data.subarray(pos, newline).toString());
    pos = newline + 1;
    if (!header) {
      out.set(path, undefined);
      continue;
    }
    const size = Number(header[2]);
    out.set(path, header[1] === 'blob' ? Buffer.from(data.subarray(pos, pos + size)) : undefined);
    pos += size + 1;
  }
  return out;
};

/** The index: every tracked path, relative to the git root, with its mode. */
const indexEntries = (root: string): Array<[mode: string, path: string]> =>
  git(root, ['ls-files', '--stage', '-z'])
    .split('\0')
    .filter(Boolean)
    .map(line => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf('\t') + 1)]);

/** Tracked symlinks, submodules' included, relative to the git root. Empty when git cannot list them. */
export const trackedLinks = (root: string): string[] => {
  try {
    return git(root, ['ls-files', '--stage', '--recurse-submodules', '-z'])
      .split('\0')
      .filter(line => line.startsWith('120000 '))
      .map(line => line.slice(line.indexOf('\t') + 1));
  } catch {
    return [];
  }
};

/** Submodule paths in the index, relative to the git root. */
export const submodules = (root: string): string[] => indexEntries(root).flatMap(([mode, path]) => (mode === '160000' ? [path] : []));

/**
 * Which of `paths` (relative to the git root) git ignores and does not track. Undefined when git
 * cannot tell: `check-ignore` rejects the whole list over one path inside a submodule.
 */
export const ignoredFiles = (root: string, paths: string[]): Set<string> | undefined => {
  const index = indexEntries(root);
  // A tracked file is never ignored, and check-ignore costs about 0.2 ms a path.
  const tracked = new Set(index.map(([, path]) => path));
  const inSubmodule = index.flatMap(([mode, path]) => (mode === '160000' ? [`${path}/`] : []));
  const asked = paths.filter(p => !tracked.has(p) && !inSubmodule.some(s => p.startsWith(s)));
  if (asked.length === 0) return new Set();
  const result = spawnSync('git', [...SAFE, 'check-ignore', '--stdin', '-z'], {
    cwd: root,
    input: `${asked.join('\0')}\0`,
    maxBuffer: MAX_BUFFER,
  });
  if (result.status !== 0 && result.status !== 1) return;
  return new Set(result.stdout.toString().split('\0').filter(Boolean));
};
