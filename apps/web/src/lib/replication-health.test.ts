import { db } from '@/lib/drizzle';

jest.mock('@/lib/drizzle', () => ({
  db: {
    execute: jest.fn(),
  },
}));

import {
  classifyReplicaRow,
  collectReplicationHealth,
  probeReplica,
  REPLICA_LAG_ALERT_SECONDS,
  type ReplicaHealth,
} from './replication-health';

const mockExecute = jest.mocked(db.execute);

function queryResult(rows: Record<string, unknown>[]) {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
}

function walSenderRow(overrides: Record<string, unknown> = {}) {
  return {
    application_name: 'main',
    client_addr: '18.153.166.51/32',
    state: 'streaming',
    sync_state: 'async',
    replay_lag_bytes: '0',
    replay_lag_seconds: 0.002,
    ...overrides,
  };
}

function slotRow(overrides: Record<string, unknown> = {}) {
  return {
    slot_name: 'snowflake_backend_slot',
    slot_type: 'logical',
    active: true,
    wal_status: 'reserved',
    retained_wal_bytes: '1000',
    ...overrides,
  };
}

function okProbe(name: string): ReplicaHealth {
  return {
    name,
    status: 'ok',
    in_recovery: true,
    replay_lsn: '2008/2F522000',
    last_xact_replay_timestamp: '2026-07-30 09:39:06+00',
    replay_delay_seconds: 0.1,
    error: null,
  };
}

// getWalSenders runs before getReplicationSlots, so the first db.execute call is
// the walsender query and the second is the slots query.
function mockPrimary(walSenders: Record<string, unknown>[], slots: Record<string, unknown>[]) {
  mockExecute
    .mockResolvedValueOnce(queryResult(walSenders))
    .mockResolvedValueOnce(queryResult(slots));
}

describe('probeReplica', () => {
  it('maps a malformed connection string to unreachable instead of throwing', async () => {
    const health = await probeReplica({ name: 'us-west', url: 'not-a-url' });

    expect(health).toMatchObject({ name: 'us-west', status: 'unreachable' });
    expect(health.error).toBeTruthy();
  });
});

describe('classifyReplicaRow', () => {
  it('flags a replica that is not in recovery', () => {
    expect(
      classifyReplicaRow({
        in_recovery: false,
        replay_lsn: null,
        last_xact_replay_timestamp: null,
        replay_delay_seconds: 0,
      })
    ).toBe('not_in_recovery');
  });

  it('flags lag beyond the alert threshold', () => {
    expect(
      classifyReplicaRow({
        in_recovery: true,
        replay_lsn: '1/1',
        last_xact_replay_timestamp: '2026-07-22 10:41:00+00',
        replay_delay_seconds: REPLICA_LAG_ALERT_SECONDS + 1,
      })
    ).toBe('lagging');
  });

  it('treats a caught-up replica as ok', () => {
    expect(
      classifyReplicaRow({
        in_recovery: true,
        replay_lsn: '1/1',
        last_xact_replay_timestamp: '2026-07-30 00:00:00+00',
        replay_delay_seconds: 0.2,
      })
    ).toBe('ok');
  });
});

describe('collectReplicationHealth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is healthy when replicas are caught up and slots are safe', async () => {
    mockPrimary([walSenderRow()], [slotRow()]);

    const report = await collectReplicationHealth({
      targets: [{ name: 'us-west', url: 'postgres://replica' }],
      probe: async target => okProbe(target.name),
    });

    expect(report.healthy).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.replicas).toEqual([expect.objectContaining({ name: 'us-west', status: 'ok' })]);
    expect(report.walSenders).toHaveLength(1);
    expect(report.slots[0].at_risk).toBe(false);
  });

  it('is unhealthy when a replica is unreachable', async () => {
    mockPrimary([walSenderRow()], [slotRow()]);

    const report = await collectReplicationHealth({
      targets: [{ name: 'us-west', url: 'postgres://replica' }],
      probe: async target => ({
        name: target.name,
        status: 'unreachable',
        in_recovery: null,
        replay_lsn: null,
        last_xact_replay_timestamp: null,
        replay_delay_seconds: null,
        error: 'connection timeout',
      }),
    });

    expect(report.healthy).toBe(false);
    expect(report.replicas[0]).toMatchObject({
      status: 'unreachable',
      error: 'connection timeout',
    });
  });

  it('marks a lost slot as at risk and unhealthy', async () => {
    mockPrimary(
      [walSenderRow()],
      [
        slotRow(),
        slotRow({ slot_name: 'snowflake_connector_gfqyzuertw', active: false, wal_status: 'lost' }),
      ]
    );

    const report = await collectReplicationHealth({
      targets: [{ name: 'us-west', url: 'postgres://replica' }],
      probe: async target => okProbe(target.name),
    });

    expect(report.healthy).toBe(false);
    const lost = report.slots.find(s => s.slot_name === 'snowflake_connector_gfqyzuertw');
    expect(lost?.at_risk).toBe(true);
  });

  it('isolates a throwing probe as an unreachable replica without blanking primary data', async () => {
    mockPrimary([walSenderRow()], [slotRow()]);

    const report = await collectReplicationHealth({
      targets: [{ name: 'us-west', url: 'postgres://replica' }],
      probe: async () => {
        throw new Error('boom');
      },
    });

    expect(report.replicas).toEqual([
      expect.objectContaining({ name: 'us-west', status: 'unreachable', error: 'boom' }),
    ]);
    expect(report.walSenders).toHaveLength(1);
    expect(report.slots).toHaveLength(1);
    expect(report.healthy).toBe(false);
  });

  it('captures primary query failures without blanking the report', async () => {
    mockExecute
      .mockRejectedValueOnce(new Error('primary down'))
      .mockResolvedValueOnce(queryResult([slotRow()]));

    const report = await collectReplicationHealth({
      targets: [{ name: 'us-west', url: 'postgres://replica' }],
      probe: async target => okProbe(target.name),
    });

    expect(report.healthy).toBe(false);
    expect(report.errors).toEqual([expect.stringContaining('pg_stat_replication: primary down')]);
    expect(report.slots).toHaveLength(1);
  });
});
