import { execFileSync } from 'node:child_process';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export const gitRoot = (cwd: string): string | undefined => {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return;
  }
};

export const mergeBase = (cwd: string, base: string): string => {
  try {
    return git(cwd, ['merge-base', base, 'HEAD']).trim();
  } catch {
    return git(cwd, ['rev-parse', '--verify', `${base}^{commit}`]).trim();
  }
};

export interface FileChange {
  status: 'A' | 'M' | 'D';
  /** Path relative to the git root, with forward slashes. */
  path: string;
}

/** Changes between `commit` and the working tree, untracked files included. Renames count as delete + add. */
export const changedFiles = (root: string, commit: string): FileChange[] => {
  const changes: FileChange[] = [];
  const parts = git(root, ['diff', '--name-status', '--no-renames', '-z', commit]).split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i][0];
    changes.push({ status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M', path: parts[i + 1] });
  }
  for (const path of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (path) changes.push({ status: 'A', path });
  }
  return changes;
};

/** File contents at `commit`, or undefined when the file did not exist there. */
export const showFile = (root: string, commit: string, path: string): Buffer | undefined => {
  try {
    return execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return;
  }
};
