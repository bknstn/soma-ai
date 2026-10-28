import { readFileSync } from 'node:fs';

// Keep the product version in one place; dependency and schema versions are separate.
export const SOMA_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
