import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { globSync } from 'tinyglobby';

export interface TailwindRequest {
  /** Project directory. Tailwind scans relative to it, like `next build` run there. */
  dir: string;
  /** Root stylesheets, absolute paths. */
  roots: string[];
  /** Absolute path -> content to scan instead of the file on disk, or `null` to leave it out. */
  overrides?: Record<string, string | null>;
}

export interface TailwindResult {
  file: string;
  version?: string;
  /** Hash of the CSS Tailwind generates. Missing when the run failed. */
  hash?: string;
  /** Files Tailwind scanned for class names. */
  files: string[];
  /** Stylesheets, plugins and configs the compile loaded. */
  deps: string[];
  error?: string;
}

const WORKER = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './tailwind-worker.ts' : './tailwind-worker.js', import.meta.url));

/** A stylesheet Tailwind turns into utilities: v4 `@import "tailwindcss"` or v3 `@tailwind utilities`. */
export const isTailwindRoot = (css: string) =>
  /@import\s+(?:url\(\s*)?['"]tailwindcss(?:\/[\w./-]*)?['"]|@tailwind\s+(?:base|components|utilities)\b/.test(css);

/**
 * Runs the project's own Tailwind in a child process: plugins and configs are project code,
 * and the compile API is async while the graph is not.
 */
export const runTailwind = (request: TailwindRequest): TailwindResult[] => {
  try {
    const output = execFileSync(process.execPath, [WORKER], {
      input: JSON.stringify(request),
      cwd: request.dir,
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(output.toString()) as TailwindResult[];
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    const message = stderr ? (stderr.split('\n').find(l => /error/i.test(l)) ?? stderr.split('\n')[0]) : (error as Error).message;
    return request.roots.map(file => ({ file, files: [], deps: [], error: message }));
  }
};

const SKIP = ['**/node_modules/**', '**/.git/**', '**/.next/**', '**/.turbo/**', '**/.vercel/**', '**/dist/**', '**/build/**', '**/out/**'];
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp[34]|webm|mov|wav|ogg|pdf|zip|gz|wasm|node)$/i;

/** When Tailwind cannot run, everything it might scan is hashed whole instead. */
export const tailwindFallbackFiles = (dir: string): string[] =>
  globSync('**/*', { cwd: dir, absolute: true, ignore: SKIP, onlyFiles: true })
    .filter(f => !BINARY.test(f) && !/(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f))
    .sort();
