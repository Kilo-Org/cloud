import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const srcDir = join(root, 'src');
const allowedDirectWebComponentImporters = new Set([
  'src/components/KiloCrabIcon.tsx',
  'src/components/shared/Banner.tsx',
]);

const allowedDirectWebComponentPrefixes = ['src/components/ui/'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
const webComponentImportPattern = /from\s+['"]@web\/components\//g;

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async entry => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(path);
      if (!sourceExtensions.has(extname(entry.name))) return [];
      return [path];
    })
  );

  return files.flat();
}

function isAllowedDirectImporter(relativePath) {
  return (
    allowedDirectWebComponentImporters.has(relativePath) ||
    allowedDirectWebComponentPrefixes.some(prefix => relativePath.startsWith(prefix))
  );
}

const violations = [];

for (const file of await collectSourceFiles(srcDir)) {
  const relativePath = relative(root, file);
  if (isAllowedDirectImporter(relativePath)) continue;

  const source = await readFile(file, 'utf8');
  if (!webComponentImportPattern.test(source)) continue;

  violations.push(relativePath);
  webComponentImportPattern.lastIndex = 0;
}

if (violations.length > 0) {
  console.error(
    'Prototype Routes must import production web components through prototype-local seams.'
  );
  console.error(
    'Move these imports behind src/components/ui/*, src/components/shared/*, or another approved bridge:'
  );
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('Prototype production web component imports use approved local seams.');
