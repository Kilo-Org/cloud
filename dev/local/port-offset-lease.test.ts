import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquirePortOffsetLease,
  findPortConflicts,
  missingRunningServices,
  releasePortOffsetClaims,
} from './cli';
import { acquireProcessLock } from './process-lock';
import { applyPortOffset, portOffset } from './services';

test('reuses a running stack only when every requested service is live', async () => {
  const manifest = {
    session: 'kilo-dev-test',
    portOffset: 100,
    wranglerRegistryPath: '/tmp/wrangler',
    services: [
      { name: 'mobile', port: 8181, group: 'mobile', type: 'process' },
      { name: 'nextjs', port: 3100, group: 'app', type: 'nextjs' },
    ],
  };
  const live = {
    repoRoot: '/missing',
    findPane: () => ({ windowIndex: 1, paneIndex: 0 }),
    isPaneRunning: () => true,
    probe: async () => true,
  };
  assert.deepEqual(
    await missingRunningServices(manifest, 'kilo-dev-test', ['postgres', 'mobile', 'nextjs'], live),
    []
  );
  assert.deepEqual(
    await missingRunningServices(manifest, 'kilo-dev-test', ['mobile', 'event-service'], live),
    ['event-service']
  );
  assert.deepEqual(await missingRunningServices(manifest, 'another-session', ['mobile'], live), [
    'mobile',
  ]);
  assert.deepEqual(
    await missingRunningServices(manifest, 'kilo-dev-test', ['mobile', 'nextjs'], {
      ...live,
      probe: async port => port !== 8181,
    }),
    ['mobile']
  );
});

test('reuse waits through the normal service boot window', async () => {
  const manifest = {
    session: 'kilo-dev-test',
    portOffset: 100,
    wranglerRegistryPath: '/tmp/wrangler',
    services: [{ name: 'mobile', port: 8181, group: 'mobile', type: 'process' }],
  };
  let probes = 0;
  assert.deepEqual(
    await missingRunningServices(manifest, 'kilo-dev-test', ['mobile'], {
      findPane: () => ({ windowIndex: 1, paneIndex: 0 }),
      isPaneRunning: () => true,
      probe: async () => ++probes >= 3,
      waitMs: 100,
      pollMs: 1,
    }),
    []
  );
  assert.equal(probes, 3);
});

test('port conflict scan includes worker inspector ports', async () => {
  let probes = 0;
  const result = await findPortConflicts(
    ['event-service'],
    async () => ++probes === 2,
    async () => false
  );
  assert.equal(probes, 2);
  assert.match(result.conflicts[0], /^event-service-inspector:/);
});

test('automatic port selection skips conflicts and restores the offset on exhaustion', async () => {
  const leases = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-port-lease-'));
  const initialOffset = portOffset;
  let scans = 0;
  try {
    await acquirePortOffsetLease(
      [],
      false,
      '/worktree/one',
      'missing-session-one',
      leases,
      async () => ({
        conflicts: ++scans === 1 ? ['occupied:1'] : [],
        reusedHostServices: new Set<string>(),
      })
    );
    assert.equal(scans, 2);
    await releasePortOffsetClaims('/worktree/one', 'missing-session-one', leases);
    applyPortOffset(initialOffset);

    await assert.rejects(
      acquirePortOffsetLease(
        [],
        false,
        '/worktree/two',
        'missing-session-two',
        leases,
        async () => ({
          conflicts: ['occupied:1'],
          reusedHostServices: new Set<string>(),
        })
      ),
      /No free worktree port offset/
    );
    assert.equal(portOffset, initialOffset);
  } finally {
    applyPortOffset(initialOffset);
    fs.rmSync(leases, { recursive: true, force: true });
  }
});

test('keeps a port offset reserved until its stack stops', async () => {
  const leases = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-port-lease-'));
  try {
    await acquirePortOffsetLease([], true, '/worktree/one', 'missing-session-one', leases);
    await assert.rejects(
      acquirePortOffsetLease([], true, '/worktree/two', 'missing-session-two', leases),
      /reserved by another worktree/
    );
    await releasePortOffsetClaims('/worktree/one', 'missing-session-one', leases);
    await acquirePortOffsetLease([], true, '/worktree/two', 'missing-session-two', leases);
    await releasePortOffsetClaims('/worktree/two', 'missing-session-two', leases);
  } finally {
    fs.rmSync(leases, { recursive: true, force: true });
  }
});

test('reclaims a startup claim when its pid identity no longer matches', async () => {
  const leases = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-port-lease-'));
  try {
    await acquirePortOffsetLease([], true, '/worktree/one', 'missing-session-one', leases);
    const claimPath = path.join(
      leases,
      fs.readdirSync(leases).find(entry => entry.endsWith('.json'))!
    );
    const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    fs.writeFileSync(claimPath, JSON.stringify({ ...claim, identity: 'recycled-pid' }));

    await acquirePortOffsetLease([], true, '/worktree/two', 'missing-session-two', leases);
    await releasePortOffsetClaims('/worktree/two', 'missing-session-two', leases);
  } finally {
    fs.rmSync(leases, { recursive: true, force: true });
  }
});

test('does not abort claim cleanup when an offset lock is busy', async () => {
  const leases = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-port-lease-'));
  try {
    await acquirePortOffsetLease([], true, '/worktree/one', 'missing-session-one', leases);
    const claim = fs.readdirSync(leases).find(entry => entry.endsWith('.json'))!;
    const unlock = await acquireProcessLock(
      path.join(leases, claim.replace(/\.json$/, '.lock')),
      'test port offset'
    );
    try {
      await releasePortOffsetClaims('/worktree/one', 'missing-session-one', leases, 0);
      assert.equal(fs.existsSync(path.join(leases, claim)), true);
    } finally {
      await unlock();
    }
    await releasePortOffsetClaims('/worktree/one', 'missing-session-one', leases);
    assert.equal(fs.existsSync(path.join(leases, claim)), false);
  } finally {
    fs.rmSync(leases, { recursive: true, force: true });
  }
});

test('does not abort claim cleanup when removing a claim fails', async () => {
  const leases = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-port-lease-'));
  try {
    await acquirePortOffsetLease([], true, '/worktree/one', 'missing-session-one', leases);
    await releasePortOffsetClaims('/worktree/one', 'missing-session-one', leases, 0, () => {
      throw new Error('read-only filesystem');
    });
  } finally {
    fs.rmSync(leases, { recursive: true, force: true });
  }
});
