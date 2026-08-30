import { existsSync, readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

it('uses Lucide icon subpaths with runtime files', () => {
  const source = readFileSync(new URL('icons.ts', import.meta.url), 'utf8');
  const imports = source.match(/(?<=from ')lucide-react-native\/icons\/[^']+/g) ?? [];

  expect(imports.length).toBeGreaterThan(0);
  const missing = imports.filter(specifier => !existsSync(new URL(import.meta.resolve(specifier))));
  expect(missing).toEqual([]);
});
