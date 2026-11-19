import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { groupBatches, MANIFEST_COLUMNS, parseManifest, type SeedMap } from './batch-manifest';
import { batchTaker, parseDeviceSpec, runBatches, type RunDevice } from './batch-runner';

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

test('a seeded batch goes to the device whose own map resolves it', () => {
  const batches = groupBatches(
    parseManifest(
      [
        MANIFEST_COLUMNS.join('\t'),
        'T2-G09a\tT2\tsigned-in\tbase\tios\thappy\t-\tkiloapp:///(app)/agent-chat/{{seed:sessions.rootSessionId}}\tscreen\t(app)/agent-chat/[session-id]',
        'T2-G12\tT2\tsigned-in\tbase\tios\thappy\t-\tkiloapp:///(app)/security-agent/{{seed:security-org-scopes.organizationId}}/settings/sla\tscreen\t(app)/security-agent/[scope]/settings/sla',
        'T2-G03\tT2\tsigned-in\tbase\tios\thappy\t-\tkiloapp:///(app)/(tabs)/(3_profile)/account\tscreen\t(app)/(tabs)/(3_profile)/account',
      ].join('\n')
    )
  );
  const map = (sessions: boolean): SeedMap => ({
    email: 'kilo-e2e@example.com',
    createdAt: '2026-11-19T00:00:00.000Z',
    steps: {
      sessions: sessions
        ? { topic: 'app:mobile-sheet-fixtures', ok: true, values: { rootSessionId: 'ses_root' } }
        : { topic: 'app:mobile-sheet-fixtures', ok: false, values: {}, error: 'exit 1' },
      'security-org-scopes': {
        topic: 'app:mobile-security-agent-notification-scopes',
        ok: true,
        values: { organizationId: 'org' },
      },
    },
  });
  const partial: RunDevice = {
    id: 'ios1',
    metro: 'http://127.0.0.1:1',
    platform: 'ios',
    seeds: map(false),
  };
  const full: RunDevice = {
    id: 'ios2',
    metro: 'http://127.0.0.1:2',
    platform: 'ios',
    seeds: map(true),
  };
  const none: RunDevice = { id: 'ios3', metro: 'http://127.0.0.1:3', platform: 'ios' };
  const takes = batchTaker(batches, [partial, full, none]);
  const taken = (device: RunDevice) =>
    batches.filter(batch => takes(device, batch)).map(batch => batch.id);
  assert.deepEqual(taken(partial), ['T2-G12', 'T2-G03']);
  assert.deepEqual(taken(full), ['T2-G09a', 'T2-G12', 'T2-G03']);
  assert.deepEqual(taken(none), ['T2-G03']);
  // When no map resolves a seeded batch, a device with a map takes it and
  // records which ids are missing.
  const [sessionsBatch] = batches;
  assert.ok(sessionsBatch);
  const onlyPartial = batchTaker(batches, [partial, none]);
  assert.equal(onlyPartial(partial, sessionsBatch), true);
  assert.equal(onlyPartial(none, sessionsBatch), false);
});
