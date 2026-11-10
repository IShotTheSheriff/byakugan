import { readFileSync } from 'node:fs';

let cached: string | undefined;

/** The version of byakugan that is running, from its own package.json. */
export const toolVersion = (): string => {
  cached ??= (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  return cached;
};
