import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogNeedsPublication, readSourceCatalog } from './runtime-publication-need.mjs';

const preinstalled = { mode: 'preinstalled', image: 'all-in-one' };
const downloaded = { mode: 'downloaded', image: 'runtime-free' };

test('only a downloaded default or named target needs publication', () => {
  assert.equal(catalogNeedsPublication({ default: preinstalled, targets: {} }), false);
  assert.equal(
    catalogNeedsPublication({ default: preinstalled, targets: { production: preinstalled } }),
    false
  );
  assert.equal(
    catalogNeedsPublication({ default: preinstalled, targets: { production: downloaded } }),
    true
  );
  assert.equal(catalogNeedsPublication({ default: downloaded, targets: {} }), true);
  assert.throws(() => catalogNeedsPublication({ default: preinstalled }), /Invalid/);
});

test('reads the catalog at the exact source SHA', async () => {
  const sha = 'a'.repeat(40);
  let url;
  const catalog = await readSourceCatalog(sha, 'token', async requested => {
    url = requested;
    return new Response(JSON.stringify({ default: downloaded, targets: {} }));
  });
  assert.equal(
    url,
    'https://api.github.com/repos/Kilo-Org/cloud/contents/services/cloud-agent-next/runtime-targets.json?ref=' +
      sha
  );
  assert.equal(catalogNeedsPublication(catalog), true);
  await assert.rejects(readSourceCatalog('main', 'token'), /exact SHA/);
  await assert.rejects(
    readSourceCatalog(sha, 'token', async () => new Response('', { status: 404 })),
    /could not be read/
  );
});
