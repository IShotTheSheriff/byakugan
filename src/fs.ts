import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

/** Assets above this size are hashed in chunks instead of read into memory. */
export const BIG_FILE = 16 * 1024 * 1024;

const hashStream = (file: string): string => {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (let n = readSync(fd, chunk, 0, chunk.length, null); n > 0; n = readSync(fd, chunk, 0, chunk.length, null)) hash.update(chunk.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex').slice(0, 20);
};

/**
 * A regular file's bytes, or only its hash when it is a big asset (`whole` reads it anyway).
 * Undefined for missing files, directories, devices and FIFOs: `public/zero -> /dev/zero` and a
 * `package.json` that is a FIFO must not be read.
 */
export const readRegular = (file: string, whole = false): { content: Buffer } | { hash: string } | undefined => {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return;
  }
  if (!stat.isFile()) return;
  if (!whole && stat.size > BIG_FILE) return { hash: hashStream(file) };
  try {
    return { content: readFileSync(file) };
  } catch {
    return;
  }
};

/** A regular file as UTF-8 text, without a byte-order mark. Undefined when it is missing or not a regular file. */
export const readText = (file: string): string | undefined => {
  const read = readRegular(file, true);
  return read && 'content' in read ? read.content.toString('utf8').replace(/^﻿/, '') : undefined;
};

/**
 * `text` with every `open`...`close` block replaced by a space. Linear time: a regex like
 * `/\/\*[\s\S]*?\*\//g` rescans to the end from every unclosed `open`, which is quadratic.
 */
export const stripBlocks = (text: string, open: string, close: string): string => {
  let out = '';
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf(open, pos);
    if (start === -1) break;
    const end = text.indexOf(close, start + open.length);
    out += `${text.slice(pos, start)} `;
    if (end === -1) return out;
    pos = end + close.length;
  }
  return out + text.slice(pos);
};
