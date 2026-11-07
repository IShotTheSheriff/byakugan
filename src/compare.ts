import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Next.js makes new server action and preview mode secrets for every build. Their JSON shows up
 * compact, indented and escaped inside JavaScript strings.
 */
const SECRET = /(\\*"(?:encryptionKey|bypassToken|previewModeId|previewModeSigningKey|previewModeEncryptionKey)\\*":\s*\\*")[^"\\]*/g;
/**
 * Next.js build caches, traces and timings at the top of `.next` (or Vercel's `.vercel/output`),
 * which differ between two builds of the same code. Other outputs may hold these names as content.
 */
const SKIPPED = /^(?:cache|diagnostics|trace|trace-build|\.turbo)(?:\/|$)|^static\/_next\/__private\/trace/;
const isNextOutput = (dir: string) => ['BUILD_ID', 'build-manifest.json', 'config.json'].some(f => existsSync(join(dir, f)));

/** Files under `dir` with `/` separators, sorted, links included as links. */
const listFiles = (dir: string, maps: boolean): string[] => {
  const out: string[] = [];
  const next = isNextOutput(dir);
  const stack = [''];
  while (stack.length > 0) {
    const prefix = stack.pop() as string;
    const entries = readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if ((next && SKIPPED.test(path)) || (!maps && entry.name.endsWith('.map'))) continue;
      if (entry.isDirectory()) stack.push(path);
      else out.push(path);
    }
  }
  return out.sort();
};

/** What differs between builds of the same code: the build ID and the checkout's absolute path. */
interface Noise {
  buildId?: string;
  root?: string;
}

const noiseOf = (dir: string, files: string[]): Noise => {
  const noise: Noise = {};
  const id = files.find(f => f === 'BUILD_ID' || f.endsWith('/BUILD_ID'));
  if (id) noise.buildId = readFileSync(join(dir, id), 'utf8').trim() || undefined;
  // Next.js names the checkout as the tracing root in its server config.
  for (const f of files.filter(f => f.endsWith('required-server-files.json'))) {
    try {
      const root = (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { config?: { outputFileTracingRoot?: unknown } }).config?.outputFileTracingRoot;
      if (typeof root === 'string' && root.length > 1) noise.root = root;
    } catch {}
  }
  return noise;
};

const normalize = (text: string, noise: Noise) => {
  let out = text.replace(SECRET, '$1<secret>');
  if (noise.buildId && noise.buildId.length >= 6) out = out.replaceAll(noise.buildId, '<build-id>');
  if (noise.root) out = out.replaceAll(noise.root, '<checkout>');
  return out;
};

const read = (file: string, noise: Noise) => {
  if (lstatSync(file).isSymbolicLink()) return `link:${readlinkSync(file)}`;
  return normalize(readFileSync(file).toString('latin1'), noise);
};

/** The first place two texts differ, with a little context. */
const firstDifference = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 80);
  return `  base:  ${JSON.stringify(a.slice(from, i + 80))}\n  fresh: ${JSON.stringify(b.slice(from, i + 80))}`;
};

export interface BuildDifference {
  path: string;
  detail: string;
}

/**
 * Compares two build output directories, such as two `.next` folders. A build that byakugan
 * called unaffected should match the base build once the per-build noise is gone: secrets,
 * the build ID, the checkout path, caches and traces. Anything else means byakugan missed an
 * input. Turbopack output matches byte for byte; webpack output may need the same settings
 * on both sides. Source maps (`.map`) are left out unless `maps` is set: they embed the source,
 * so a comment or formatting edit changes them while the code stays the same.
 */
export const compareBuilds = (base: string, fresh: string, options: { maps?: boolean } = {}): BuildDifference[] => {
  const baseFiles = listFiles(base, options.maps === true);
  const freshFiles = listFiles(fresh, options.maps === true);
  const baseNoise = noiseOf(base, baseFiles);
  const freshNoise = noiseOf(fresh, freshFiles);
  const left = new Map(baseFiles.map(f => [normalize(f, baseNoise), f]));
  const right = new Map(freshFiles.map(f => [normalize(f, freshNoise), f]));
  const out: BuildDifference[] = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(name);
    const b = right.get(name);
    if (!a || !b) {
      out.push({ path: name, detail: `only in the ${a ? 'base' : 'fresh'} build` });
      continue;
    }
    const x = read(join(base, a), baseNoise);
    const y = read(join(fresh, b), freshNoise);
    if (x !== y) out.push({ path: name, detail: `contents differ\n${firstDifference(x, y)}` });
  }
  return out;
};
