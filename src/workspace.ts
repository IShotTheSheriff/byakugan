import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { readText } from './fs.ts';
import { DEPENDENCY_FIELDS } from './graph.ts';
import { safeGlob } from './glob.ts';
import { parseJsonc } from './jsonc.ts';
import { isConfigEntry, loadProject, type Config, type Project } from './project.ts';

/** `workspaces` in package.json (a list, or `{ packages }`) and `packages` in pnpm-workspace.yaml. */
export const workspacePatterns = (root: string): string[] => {
  const patterns: string[] = [];
  const manifest = parseJsonc(readText(join(root, 'package.json')) ?? '{}') as { workspaces?: unknown } | undefined;
  const workspaces = manifest?.workspaces;
  const list = Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown } | undefined)?.packages;
  if (Array.isArray(list)) for (const p of list) if (typeof p === 'string') patterns.push(p);
  const pnpm = readText(join(root, 'pnpm-workspace.yaml'));
  if (pnpm) {
    let inPackages = false;
    for (const line of pnpm.split(/\r?\n/)) {
      // `packages: ['apps/*', "packages/*"]` on one line.
      const flow = /^packages\s*:\s*\[([^\]]*)\]/.exec(line);
      if (flow) {
        for (const item of flow[1].split(',')) {
          const value = item.trim().replace(/^(['"])(.*)\1$/, '$2');
          if (value) patterns.push(value);
        }
        continue;
      }
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (/^\S/.test(line)) inPackages = false;
      const item = inPackages ? /^\s*-\s*(['"]?)(.+?)\1\s*(?:#.*)?$/.exec(line) : null;
      if (item) patterns.push(item[2]);
    }
  }
  return patterns.map(p => p.replace(/^\.\//, '').replace(/\/$/, ''));
};

export interface WorkspaceApp {
  /** Directory relative to the workspace root, with `/`. */
  path: string;
  /** Missing when the project could not load, for example over an invalid `byakugan.json`. */
  project?: Project;
  error?: string;
}

/**
 * Workspace packages that are apps: a detected framework, a Cloudflare Worker, a `byakugan.json`,
 * or a package that is not a library. A library is imported by the apps that use it, so its own
 * verdict says nothing. A package is a library when another workspace package lists it in
 * `dependencies`, `peerDependencies` or `optionalDependencies`, or lists it only in
 * `devDependencies` and it has no `start` script (a server that end-to-end tests depend on is
 * an app). Packages without entries of their own are skipped.
 */
export const workspaceApps = (root: string, config?: Config): WorkspaceApp[] => {
  const patterns = workspacePatterns(root);
  if (patterns.length === 0) throw new Error(`${root}: no workspaces in package.json or pnpm-workspace.yaml`);
  const globs = patterns.map(p => (p.startsWith('!') ? `!${p.slice(1)}/package.json` : `${p}/package.json`));
  const dirs = safeGlob(globs, { cwd: root, ignore: ['**/node_modules/**', '**/.git/**'] })
    .map(file => dirname(file))
    .filter(dir => dir !== root)
    .sort();
  const names = new Map<string, Record<string, unknown>>();
  for (const dir of dirs) {
    const manifest = parseJsonc(readText(join(dir, 'package.json')) ?? '{}') as Record<string, unknown> | undefined;
    names.set(dir, manifest ?? {});
  }
  const dependedOn = new Set<string>();
  const devOnly = new Set<string>();
  for (const manifest of names.values()) {
    for (const field of DEPENDENCY_FIELDS) {
      const deps = manifest[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const name of Object.keys(deps)) (field === 'devDependencies' ? devOnly : dependedOn).add(name);
    }
  }
  const isLibrary = (manifest: Record<string, unknown> | undefined) => {
    const name = manifest?.name;
    if (typeof name !== 'string') return false;
    if (dependedOn.has(name)) return true;
    const scripts = manifest?.scripts as Record<string, unknown> | undefined;
    return devOnly.has(name) && typeof scripts?.start !== 'string';
  };
  const apps: WorkspaceApp[] = [];
  for (const dir of dirs) {
    const path = relative(root, dir).split(sep).join('/');
    let project: Project;
    try {
      project = loadProject({ cwd: dir, config });
    } catch (error) {
      apps.push({ path, error: String((error as Error).message ?? error) });
      continue;
    }
    if (project.entries.length === 0 || project.entries.every(isConfigEntry)) continue;
    const app = project.framework !== 'none' || project.workers || existsSync(join(dir, 'byakugan.json')) || !isLibrary(names.get(dir));
    if (app) apps.push({ path, project });
  }
  return apps;
};
