import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { openPackage, sha256 } from './pinned.mjs';
import { archiveOf, goodMembers } from './test-archive.mjs';

const BUILD_ID = '0123456789ab';
const receipt = JSON.stringify({ build_id: BUILD_ID });
const members = goodMembers.map(([name, contents]) =>
  name === 'build-receipt.json' ? [name, receipt] : [name, contents]
);

/** A source.json that pins `archive`. */
const pin = archive => ({
  repository: 'nteract/nteract',
  tag: `pages-${BUILD_ID}`,
  sha256: sha256(archive),
});

test('opens the pinned package and removes it afterwards', async () => {
  const archive = archiveOf(members);
  let staged;
  const result = await openPackage(archive, pin(archive), opened => {
    staged = opened.staged;
    assert.equal(opened.receipt.build_id, BUILD_ID);
    return readFileSync(path.join(staged, 'output', 'worker.js'), 'utf8');
  });
  assert.equal(result, 'export default { fetch() {} }');
  assert.equal(existsSync(staged), false);
});

test('refuses an archive the pin does not name', async () => {
  const archive = archiveOf(members);
  const source = { ...pin(archive), sha256: '0'.repeat(64) };
  await assert.rejects(
    openPackage(archive, source, () => {}),
    /but source\.json pins 0{64}/
  );
});

test('refuses a package without the output shell', async () => {
  const archive = archiveOf(members.filter(([name]) => !name.startsWith('output/')));
  await assert.rejects(
    openPackage(archive, pin(archive), () => {}),
    /The package has no output/
  );
});

test('refuses a package whose output shell lacks its configuration', async () => {
  const archive = archiveOf(members.filter(([name]) => name !== 'output/wrangler.json'));
  await assert.rejects(
    openPackage(archive, pin(archive), () => {}),
    /^Error: The package has no output\/wrangler\.json$/
  );
});

test('refuses a package from another build', async () => {
  const archive = archiveOf(members);
  const source = { ...pin(archive), tag: 'pages-ba9876543210' };
  await assert.rejects(
    openPackage(archive, source, () => {}),
    /reports build 0123456789ab, not the one pages-ba9876543210 names/
  );
});
