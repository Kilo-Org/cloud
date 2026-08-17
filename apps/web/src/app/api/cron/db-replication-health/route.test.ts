import { captureException } from '@sentry/nextjs';

import { collectReplicationHealth, type ReplicationHealthReport } from '@/lib/replication-health';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/replication-health', () => ({
  collectReplicationHealth: jest.fn(),
  isReplicationSlotMonitored: (slotName: string) => !slotName.startsWith('snowflake_'),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

import { GET } from './route';

const mockCollect = jest.mocked(collectReplicationHealth);
const mockCaptureException = jest.mocked(captureException);

function report(overrides: Partial<ReplicationHealthReport> = {}): ReplicationHealthReport {
  return {
    healthy: true,
    timestamp: '2026-07-30T09:39:06.000Z',
    replicas: [],
    walSenders: [],
    slots: [],
    errors: [],
    ...overrides,
  };
}

function createRequest(headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/cron/db-replication-health', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/db-replication-health', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockCollect.mockResolvedValue(report());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 401 with the wrong cron secret', async () => {
    const response = await GET(createRequest({ authorization: 'Bearer wrong' }));

    expect(response.status).toBe(401);
    expect(mockCollect).not.toHaveBeenCalled();
  });

  it('does not alert when replication is healthy', async () => {
    const response = await GET(createRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ healthy: true, problems: [] })
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('alerts when a replica is lagging', async () => {
    mockCollect.mockResolvedValue(
      report({
        healthy: false,
        replicas: [
          {
            name: 'us-west',
            status: 'lagging',
            in_recovery: true,
            replay_lsn: '1EE6/65035140',
            receive_lsn: '1EE6/65035140',
            receive_replay_gap_bytes: '0',
            last_xact_replay_timestamp: '2026-07-22 10:41:00+00',
            replay_delay_seconds: 691200,
            error: null,
          },
        ],
      })
    );

    const response = await GET(createRequest({ authorization: 'Bearer cron-secret' }));

    const body = await response.json();
    expect(body.healthy).toBe(false);
    expect(body.problems).toEqual([expect.stringContaining('replica us-west: lagging')]);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('emits one walsender line per replica so lag can be split into transport vs replay', async () => {
    mockCollect.mockResolvedValue(
      report({
        walSenders: [
          {
            application_name: 'main',
            client_addr: '54.153.89.218/32',
            state: 'streaming',
            sync_state: 'async',
            sent_lag_bytes: '0',
            flush_lag_bytes: '690368',
            replay_lag_bytes: '135858008',
            write_lag_seconds: 0.15,
            flush_lag_seconds: 0.15,
            replay_lag_seconds: 199,
          },
        ],
      })
    );

    await GET(createRequest({ authorization: 'Bearer cron-secret' }));

    const logged = jest
      .mocked(console.log)
      .mock.calls.map(([line]) => JSON.parse(String(line)))
      .filter(entry => entry.type === 'db_replication_wal_sender');

    expect(logged).toEqual([
      expect.objectContaining({
        client_addr: '54.153.89.218/32',
        flush_lag_seconds: 0.15,
        replay_lag_seconds: 199,
        timestamp: '2026-07-30T09:39:06.000Z',
      }),
    ]);
  });

  it('alerts when a slot is at risk', async () => {
    mockCollect.mockResolvedValue(
      report({
        healthy: false,
        slots: [
          {
            slot_name: 'other_logical_consumer',
            slot_type: 'logical',
            active: false,
            wal_status: 'lost',
            retained_wal_bytes: '0',
            at_risk: true,
          },
        ],
      })
    );

    const response = await GET(createRequest({ authorization: 'Bearer cron-secret' }));

    const body = await response.json();
    expect(body.problems).toEqual([
      expect.stringContaining('slot other_logical_consumer: wal_status=lost'),
    ]);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('does not alert for an at-risk Snowflake slot while replication is disabled', async () => {
    mockCollect.mockResolvedValue(
      report({
        slots: [
          {
            slot_name: 'snowflake_backend_slot',
            slot_type: 'logical',
            active: false,
            wal_status: 'lost',
            retained_wal_bytes: '0',
            at_risk: true,
          },
        ],
      })
    );

    const response = await GET(createRequest({ authorization: 'Bearer cron-secret' }));

    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ healthy: true, problems: [] })
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
