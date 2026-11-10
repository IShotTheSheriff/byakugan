/**
 * Terminal styling. Text keeps the same words with and without color, so scripts and tests
 * read one format. Marks such as `✔` appear only when color is on.
 */

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
} as const;

export type Paint = keyof typeof CODES;

export type Style = { [K in Paint]: (text: string) => string } & {
  /** Whether color is on. Marks and progress lines follow it. */
  on: boolean;
  /** `text` in several paints at once, e.g. `paint(['bold', 'green'], 'ok')`. */
  paint: (paints: Paint | Paint[] | undefined, text: string) => string;
};

/** `NO_COLOR` turns color off, `FORCE_COLOR` (not `0`) turns it on, otherwise a terminal decides. */
export const colorEnabled = (stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean => {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return env.FORCE_COLOR !== '0';
  return stream.isTTY === true && env.TERM !== 'dumb';
};

export const createStyle = (on: boolean): Style => {
  const one = (name: Paint) => (text: string) => (on && text ? `\u001b[${CODES[name][0]}m${text}\u001b[${CODES[name][1]}m` : text);
  const style = { on } as Style;
  for (const name of Object.keys(CODES) as Paint[]) style[name] = one(name);
  style.paint = (paints, text) => {
    if (!paints) return text;
    let out = text;
    for (const name of Array.isArray(paints) ? paints : [paints]) out = style[name](out);
    return out;
  };
  return style;
};

export const PLAIN = createStyle(false);

/** A piece of a line: plain text, or text with its paints. Text is escaped before it is painted. */
export type Part = string | [Paint | Paint[], string];
export type Line = string | Part[];

/** Edit distance, for "did you mean". */
const distance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
};

/** The candidate closest to `input`, when it is close enough to be a typo. */
export const closest = (input: string, candidates: string[]): string | undefined => {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = candidate.startsWith(input) || input.startsWith(candidate) ? 1 : distance(input, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
};

/** Breaks `text` into lines of at most `width` characters, each after `indent`. */
export const wrap = (text: string, indent = '', width = Math.min(process.stdout.columns || 100, 100)): string[] => {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      out.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(indent + line);
  return out;
};
