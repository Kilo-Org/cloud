import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePrototypeRoute } from './prototype-route-authoring';

test('route authoring validation accepts a route that follows prototype conventions', async () => {
  const appDir = await mkdtemp(join(tmpdir(), 'prototype-route-authoring-'));
  const routeDir = join(appDir, 'valid-prototype');
  await mkdir(routeDir);
  await writeFile(join(routeDir, 'page.tsx'), 'export default function Page() { return null; }');
  await writeFile(
    join(routeDir, 'prototype.json'),
    JSON.stringify({
      title: 'Valid prototype',
      description: 'A route with valid metadata.',
      tags: ['Review'],
    })
  );

  const result = validatePrototypeRoute({ appDir, slug: 'valid-prototype' });

  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.recommendedImports, [
    '@/components/prototype-kit',
    '@/components/ui/*',
    '@/components/shared/*',
  ]);
});

test('route authoring validation reports missing pages and catalog-aligned metadata diagnostics', async () => {
  const appDir = await mkdtemp(join(tmpdir(), 'prototype-route-authoring-'));
  const routeDir = join(appDir, 'invalid-prototype');
  await mkdir(routeDir);
  await writeFile(
    join(routeDir, 'prototype.json'),
    '{"title":"Invalid","description":"Missing tags"}'
  );

  const result = validatePrototypeRoute({ appDir, slug: 'invalid-prototype' });

  assert.equal(result.valid, false);
  assert.deepEqual(result.issues, [
    {
      severity: 'error',
      code: 'missing-page',
      message: 'Prototype routes need a page file such as page.tsx.',
    },
    {
      severity: 'warning',
      code: 'invalid-metadata',
      message: 'prototype.json must include a non-empty title, description, and tags array.',
    },
  ]);
});
