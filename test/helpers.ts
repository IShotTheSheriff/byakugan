import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyze } from '../src/index.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** Copies a fixture to a fresh temp dir so tests can edit it. */
export const fixture = (name: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `byakugan-${name}-`)));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
};

export const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');

export const write = (dir: string, path: string, content: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
};

export const edit = (dir: string, path: string, change: (source: string) => string) => {
  const before = read(dir, path);
  const after = change(before);
  if (after === before) throw new Error(`edit of ${path} changed nothing`);
  write(dir, path, after);
};

export const git = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export const initRepo = (dir: string) => {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A', '-f');
  git(dir, 'commit', '-q', '-m', 'base');
};

export const commitAll = (dir: string, message: string) => {
  git(dir, 'add', '-A', '-f');
  git(dir, 'commit', '-q', '-m', message);
};

export const fingerprintOf = (dir: string, cwd = dir) => analyze({ cwd }).fingerprint();

export const liveKeys = (cwd: string) => [...analyze({ cwd }).live.keys()].sort();
