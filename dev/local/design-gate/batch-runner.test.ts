import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { groupBatches, MANIFEST_COLUMNS, parseManifest } from './batch-manifest';
import { parseDeviceSpec, runBatches } from './batch-runner';

test('a device spec may carry the seed map of its own account', () => {
  assert.deepEqual(parseDeviceSpec('ios1@http://127.0.0.1:28081@/tmp/ios1.json', 'ios'), {
    id: 'ios1',
    metro: 'http://127.0.0.1:28081',
    platform: 'ios',
    seedsFile: '/tmp/ios1.json',
  });
  assert.equal(
    parseDeviceSpec('emulator-5554@http://127.0.0.1:8081', 'android').seedsFile,
    undefined
  );
  assert.throws(() => parseDeviceSpec('ios1@http://127.0.0.1:28081@', 'ios'), /--device must be/);
});

test('a seeded batch is never given to a device without a seed map', async () => {
  const [batch] = groupBatches(
    parseManifest(
      [
        MANIFEST_COLUMNS.join('\t'),
        'T2-G12\tT2\tsigned-in\tbase\tios\thappy\t-\tkiloapp:///(app)/security-agent/{{seed:security-org-scopes.organizationId}}/settings/sla\tscreen\t(app)/security-agent/[scope]/settings/sla',
      ].join('\n')
    )
  );
  assert.ok(batch);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'batches-test-'));
  const lines: string[] = [];
  const code = await runBatches(
    {
      devices: [{ id: 'ios2', metro: 'http://127.0.0.1:28082', platform: 'ios' }],
      out,
      phase: 'signed-in',
      batches: [batch],
      cells: [],
      restart: true,
    },
    line => lines.push(line)
  );
  assert.equal(code, 2);
  assert.equal(
    fs.readFileSync(path.join(out, 'summary.tsv'), 'utf8').split('\n')[1],
    'T2-G12\tT2\tsigned-in\t-\t2\tno-seed-map\t0\t0'
  );
  assert.equal(fs.existsSync(path.join(out, 'T2-G12')), false);
  assert.ok(lines.some(line => line.includes('no --device names a seed map')));
});
