import { readFileSync } from 'node:fs';
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
export const VERSION = metadata.version;
