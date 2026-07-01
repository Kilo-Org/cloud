import { NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'internal-secret',
}));

jest.mock('@/lib/drizzle', () => ({
  db: {
    execute: jest.fn(),
  },
}));

import { GET } from './route';

const mockExecute = jest.mocked(db.execute);

function queryResult(rows: Record<string, unknown>[]) {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
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
    mockExecute.mockResolvedValue(queryResult([]));
  });

  it('returns 401 without the internal secret', async () => {
    const response = await GET(createRequest());

    expect(response.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns replication lag for every target reported by Postgres', async () => {
    mockExecute.mockResolvedValue(
      queryResult([
        {
          pid: 123,
          application_name: 'walreceiver',
          client_addr: '10.0.0.10',
          client_hostname: null,
          client_port: 5432,
          state: 'streaming',
          sync_state: 'async',
          sent_lsn: '0/5000000',
          write_lsn: '0/4FFFFF0',
          flush_lsn: '0/4FFFFE0',
          replay_lsn: '0/4FFFFD0',
          sent_lag_bytes: '0',
          write_lag_bytes: '16',
          flush_lag_bytes: '32',
          replay_lag_bytes: '48',
          write_lag_seconds: 0.1,
          flush_lag_seconds: 0.2,
          replay_lag_seconds: 0.3,
        },
      ])
    );

    const response = await GET(createRequest({ 'X-Internal-Secret': 'internal-secret' }));

    expect(response.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      targets: [
        expect.objectContaining({
          application_name: 'walreceiver',
          client_addr: '10.0.0.10',
          replay_lag_bytes: '48',
          replay_lag_seconds: 0.3,
        }),
      ],
      timestamp: expect.any(String),
    });
  });
});
