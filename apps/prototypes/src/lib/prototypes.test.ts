import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { getPrototypeCatalog, getPrototypeCatalogState } from './prototypes';

test('catalog reports invalid metadata while keeping route discoverable with fallback copy', async () => {
  const appDir = await mkdtemp(join(tmpdir(), 'prototype-catalog-'));
  const routeDir = join(appDir, 'broken-metadata');
  await mkdir(routeDir);
  await writeFile(join(routeDir, 'page.tsx'), 'export default function Page() { return null; }');
  await writeFile(
    join(routeDir, 'prototype.json'),
    '{"title":"Broken","description":"Missing tags"}'
  );

  const catalog = getPrototypeCatalogState(appDir);

  assert.deepEqual(
    catalog.entries.map(entry => ({
      slug: entry.slug,
      title: entry.title,
      metadataState: entry.metadataState,
    })),
    [
      {
        slug: 'broken-metadata',
        title: 'Broken Metadata',
        metadataState: 'invalid',
      },
    ]
  );
  assert.deepEqual(catalog.diagnostics, [
    {
      slug: 'broken-metadata',
      severity: 'warning',
      code: 'invalid-metadata',
      message: 'prototype.json must include a non-empty title, description, and tags array.',
    },
  ]);
});

test('catalog discovers eligible routes with stable hrefs, fallback metadata, and title sorting', async () => {
  const appDir = await mkdtemp(join(tmpdir(), 'prototype-catalog-'));
  await writeRoute(appDir, 'zebra-flow', {
    metadata: {
      title: 'Zebra flow',
      description: 'Valid metadata stays attached to the route.',
      tags: ['Review'],
    },
  });
  await writeRoute(appDir, 'alpha-flow');
  await writeRoute(appDir, '_private-flow');
  await writeRoute(appDir, '(grouped-flow)');
  await mkdir(join(appDir, 'api'));
  await mkdir(join(appDir, 'no-page'));

  const catalog = getPrototypeCatalogState(appDir);

  assert.deepEqual(
    catalog.entries.map(entry => ({
      slug: entry.slug,
      href: entry.href,
      title: entry.title,
      metadataState: entry.metadataState,
    })),
    [
      {
        slug: 'alpha-flow',
        href: '/alpha-flow',
        title: 'Alpha Flow',
        metadataState: 'fallback',
      },
      {
        slug: 'zebra-flow',
        href: '/zebra-flow',
        title: 'Zebra flow',
        metadataState: 'provided',
      },
    ]
  );
  assert.deepEqual(catalog.diagnostics, []);
  assert.deepEqual(getPrototypeCatalog(appDir), catalog.entries);
});

type RouteOptions = {
  metadata?: {
    title: string;
    description: string;
    tags: string[];
  };
};

async function writeRoute(appDir: string, slug: string, options: RouteOptions = {}) {
  const routeDir = join(appDir, slug);
  await mkdir(routeDir);
  await writeFile(join(routeDir, 'page.tsx'), 'export default function Page() { return null; }');
  if (options.metadata) {
    await writeFile(join(routeDir, 'prototype.json'), JSON.stringify(options.metadata));
  }
}
