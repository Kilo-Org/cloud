import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LANGUAGES,
  OUTPUT_DIR,
  collectLanguageSearchNames,
  fileName,
  generateLanguageSearchNamesSource,
} from './generate-language-search-names.mjs';

// `OUTPUT_DIR` comes from the generator itself: one definition means the assert
// can never look in a directory the generator does not write.
const expectedFiles = new Map(
  LANGUAGES.map(tag => {
    const names = collectLanguageSearchNames(tag);
    return [fileName(tag), generateLanguageSearchNamesSource(tag, names)];
  })
);

// The loops below are the assertion set. A generator that read no language tags
// would compare nothing and still print the success line, so the table has to
// stand on its own before the loops start.
if (expectedFiles.size === 0) {
  console.error(
    'Check SUPPORTED_LANGUAGES: the generator produced no language tables, so nothing was compared.'
  );
  process.exit(1);
}

// Any file under the directory that the generator no longer produces is drift
// too: the loader map keys every generated module, so a stale file is dead.
const onDisk = readdirSync(OUTPUT_DIR).filter(name => name.endsWith('.ts'));

let drifted = false;
for (const file of onDisk) {
  const expected = expectedFiles.get(file);
  if (expected === undefined) {
    console.error(`${file}: the generator no longer produces this file`);
    drifted = true;
    continue;
  }
  if (readFileSync(join(OUTPUT_DIR, file), 'utf8') !== expected) {
    console.error(`${file}: generated content is stale`);
    drifted = true;
  }
}
for (const file of expectedFiles.keys()) {
  if (!onDisk.includes(file)) {
    console.error(`${file}: missing under ${OUTPUT_DIR}`);
    drifted = true;
  }
}

if (drifted) {
  console.error(
    'Language search names drifted. Run "node scripts/generate-language-search-names.mjs".'
  );
  process.exit(1);
}

console.log(`Language search names in sync (${expectedFiles.size} files)`);
process.exit(0);
