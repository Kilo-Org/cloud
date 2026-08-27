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
import { currentComposeProject } from './infra-env';
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
  const result = await findPortConflicts(['event-service'], {
    portProbe: async () => ++probes === 2,
    dockerProbe: async () => false,
  });
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

test('automatic port selection skips the X11 range rejected by Next.js', async () => {
  const leases = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-port-lease-'));
  const initialOffset = portOffset;
  let scans = 0;
  try {
    applyPortOffset(3000);
    await acquirePortOffsetLease(
      ['nextjs'],
      false,
      '/worktree/one',
      'missing-session-one',
      leases,
      async () => {
        scans++;
        return { conflicts: [], reusedHostServices: new Set<string>() };
      }
    );
    assert.equal(portOffset, 3100);
    assert.equal(scans, 1);
    await releasePortOffsetClaims('/worktree/one', 'missing-session-one', leases);
  } finally {
    applyPortOffset(initialOffset);
    fs.rmSync(leases, { recursive: true, force: true });
  }
});

test('explicit port offsets remain unchanged even when a resolved port is reserved', async () => {
  const leases = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-port-lease-'));
  const initialOffset = portOffset;
  try {
    applyPortOffset(3000);
    await acquirePortOffsetLease(
      ['nextjs'],
      true,
      '/worktree/one',
      'missing-session-one',
      leases,
      async () => ({ conflicts: [], reusedHostServices: new Set<string>() })
    );
    assert.equal(portOffset, 3000);
    await releasePortOffsetClaims('/worktree/one', 'missing-session-one', leases);
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

test('infra ports count as conflicts unless this worktree already owns them', async () => {
  const initialOffset = portOffset;
  try {
    applyPortOffset(2500);
    const occupied = async () => true;

    const foreign = await findPortConflicts(['postgres'], {
      portProbe: occupied,
      ownProject: 'kilo-dev-sticky-slider-2500',
      portOwners: [
        { port: 7932, project: 'kilo-dev-other-2500', container: 'kilo-dev-other-2500-postgres-1' },
      ],
    });
    assert.deepEqual(foreign.conflicts, ['postgres:7932']);
    assert.deepEqual(foreign.infraConflicts, ['postgres:7932']);
    assert.deepEqual(
      foreign.foreignInfraOwners?.map(owner => owner.project),
      ['kilo-dev-other-2500']
    );

    const ours = await findPortConflicts(['postgres'], {
      portProbe: occupied,
      ownProject: 'kilo-dev-sticky-slider-2500',
      portOwners: [
        {
          port: 7932,
          project: 'kilo-dev-sticky-slider-2500',
          container: 'kilo-dev-sticky-slider-2500-postgres-1',
        },
      ],
    });
    assert.deepEqual(ours.conflicts, []);

    // Occupied by something Docker does not own: still a conflict, and no
    // owner to name in the message.
    const stranger = await findPortConflicts(['postgres'], {
      portProbe: occupied,
      ownProject: 'kilo-dev-sticky-slider-2500',
      portOwners: [],
    });
    assert.deepEqual(stranger.conflicts, ['postgres:7932']);
    assert.deepEqual(stranger.foreignInfraOwners, []);

    // No snapshot at all — a stopped or wedged docker daemon. Ownership is
    // unknowable, so the infra port is left to the compose error rather than
    // blocking a start that has nothing wrong with it.
    const noSnapshot = await findPortConflicts(['postgres'], {
      portProbe: occupied,
      ownProject: 'kilo-dev-sticky-slider-2500',
    });
    assert.deepEqual(noSnapshot.conflicts, []);
  } finally {
    applyPortOffset(initialOffset);
  }
});

test('the primary checkout does not mistake its own default project for a squatter', async () => {
  const initialOffset = portOffset;
  try {
    applyPortOffset(0);
    const scan = await findPortConflicts(['postgres'], {
      portProbe: async () => true,
      ownProject: currentComposeProject('/repo', 0),
      portOwners: [{ port: 5432, project: 'dev', container: 'dev-postgres-1' }],
    });
    assert.deepEqual(scan.conflicts, []);
  } finally {
    applyPortOffset(initialOffset);
  }
});

test('an occupied infra port on the persisted offset stops the start instead of moving it', async () => {
  const leases = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-port-lease-'));
  const initialOffset = portOffset;
  try {
    applyPortOffset(3000);
    let scans = 0;
    await assert.rejects(
      acquirePortOffsetLease(
        [],
        false,
        '/worktree/one',
        'missing-session-one',
        leases,
        async () => {
          scans++;
          return {
            conflicts: ['postgres:8432'],
            infraConflicts: ['postgres:8432'],
            foreignInfraOwners: [
              { port: 8432, project: 'kilo-dev-other-3000', container: 'other-postgres-1' },
            ],
            reusedHostServices: new Set<string>(),
          };
        },
        3000
      ),
      /holds this stack's database[\s\S]*kilo-dev-other-3000[\s\S]*KILO_PORT_OFFSET/
    );
    // Stopped at the persisted offset rather than walking 50 candidates.
    assert.equal(scans, 1);
  } finally {
    applyPortOffset(initialOffset);
    fs.rmSync(leases, { recursive: true, force: true });
  }
});

test('an infra conflict away from the persisted offset just moves on', async () => {
  const leases = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-port-lease-'));
  const initialOffset = portOffset;
  try {
    applyPortOffset(3000);
    let scans = 0;
    await acquirePortOffsetLease(
      [],
      false,
      '/worktree/one',
      'missing-session-one',
      leases,
      async () => {
        scans++;
        return scans === 1
          ? {
              conflicts: ['postgres:8432'],
              infraConflicts: ['postgres:8432'],
              foreignInfraOwners: [],
              reusedHostServices: new Set<string>(),
            }
          : { conflicts: [], reusedHostServices: new Set<string>() };
      },
      // No persisted offset: nothing of this worktree's lives at 3000 yet.
      undefined
    );
    assert.equal(scans, 2);
    assert.equal(portOffset, 3100);
    await releasePortOffsetClaims('/worktree/one', 'missing-session-one', leases);
  } finally {
    applyPortOffset(initialOffset);
    fs.rmSync(leases, { recursive: true, force: true });
  }
});
