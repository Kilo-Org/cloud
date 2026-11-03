import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vitest/config';

// Match Wrangler Data modules in both Node and Workers tests. Read the file
// during transformation so the Worker does not need filesystem access.
export const binaryAsArrayBuffer: Plugin = {
  name: 'wrangler-binary-as-arraybuffer',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!source.endsWith('?binary') || !importer) return null;
    return resolve(dirname(importer), source.slice(0, -'?binary'.length)) + '?binary';
  },
  load(id) {
    if (!id.endsWith('?binary')) return null;
    const encoded = readFileSync(id.slice(0, -'?binary'.length)).toString('base64');
    return `export default Uint8Array.from(atob(${JSON.stringify(encoded)}), char => char.charCodeAt(0)).buffer;`;
  },
};
