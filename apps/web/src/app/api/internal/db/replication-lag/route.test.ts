import { NextRequest } from 'next/server';

import { collectReplicationHealth, type ReplicationHealthReport } from '@/lib/replication-health';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'internal-secret',
}));

jest.mock('@/lib/replication-health', () => ({
  collectReplicationHealth: jest.fn(),
}));

import { GET } from './route';

const mockCollect = jest.mocked(collectReplicationHealth);

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
  return new NextRequest('http://localhost:3000/api/internal/db/replication-lag', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/internal/db/replication-lag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollect.mockResolvedValue(report());
  });

  it('returns 401 without the internal secret', async () => {
    const response = await GET(createRequest());

    expect(response.status).toBe(401);
    expect(mockCollect).not.toHaveBeenCalled();
  });

  it('returns the replication health report with the secret', async () => {
    mockCollect.mockResolvedValue(
      report({
        healthy: false,
        replicas: [
          {
            name: 'us-west',
            status: 'unreachable',
            in_recovery: null,
            replay_lsn: null,
            receive_lsn: null,
            receive_replay_gap_bytes: null,
            last_xact_replay_timestamp: null,
            replay_delay_seconds: null,
            error: 'connection timeout',
          },
        ],
      })
    );

    const response = await GET(createRequest({ 'X-Internal-Secret': 'internal-secret' }));

    expect(response.status).toBe(200);
    expect(mockCollect).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        healthy: false,
        replicas: [expect.objectContaining({ name: 'us-west', status: 'unreachable' })],
      })
    );
  });
});
