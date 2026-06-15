import { NextRequest } from 'next/server';

const mockCaptureException = jest.fn();
const mockEvaluateDispatchHealth = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

jest.mock('@/lib/cloud-agent/dispatch-health/detector', () => {
  const actual = jest.requireActual('@/lib/cloud-agent/dispatch-health/detector');
  return {
    ...actual,
    evaluateDispatchHealth: (...args: unknown[]) => mockEvaluateDispatchHealth(...args),
  };
});

import { db, sql } from '@/lib/drizzle';
import { CLOUD_AGENT_DISPATCH_RUNBOOK_URL } from '@/lib/cloud-agent/dispatch-health/health-response';
import { PgDialect } from 'drizzle-orm/pg-core';
import { GET } from './route';

const HEALTH_CHECK_KEY = 'kilo-cloud-agent-dispatch-health-check';

function makeRequest(key: string | null): NextRequest {
  const url =
    key === null
      ? 'http://localhost:3000/api/cloud-agent/dispatch-health'
      : `http://localhost:3000/api/cloud-agent/dispatch-health?key=${key}`;
  return new NextRequest(url, { method: 'GET' });
}

describe('GET /api/cloud-agent/dispatch-health', () => {
  beforeEach(() => {
    mockCaptureException.mockReset();
    mockEvaluateDispatchHealth.mockReset();
  });

  it('rejects requests with no key without querying the database', async () => {
    const transactionSpy = jest.spyOn(db, 'transaction');

    try {
      const response = await GET(makeRequest(null));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ healthy: false });
      expect(transactionSpy).not.toHaveBeenCalled();
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('rejects requests with the wrong key without querying the database', async () => {
    const transactionSpy = jest.spyOn(db, 'transaction');

    try {
      const response = await GET(makeRequest('wrong-key'));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ healthy: false });
      expect(transactionSpy).not.toHaveBeenCalled();
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('returns a completed healthy response when the detector is healthy', async () => {
    mockEvaluateDispatchHealth.mockResolvedValue({ tripped: false });
    const transactionSpy = jest.spyOn(db, 'transaction').mockImplementation(async callback => {
      const execute = jest.fn().mockResolvedValue({ rows: [] });
      return callback({ execute } as never);
    });

    try {
      const response = await GET(makeRequest(HEALTH_CHECK_KEY));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        healthy: true,
        alerts: [],
        metadata: {
          timestamp: expect.any(String),
          runbookUrl: CLOUD_AGENT_DISPATCH_RUNBOOK_URL,
          evaluationStatus: 'completed',
          detector: {
            cohortWindowMinutes: 15,
            dispatchGraceMinutes: 5,
            stuckRateThreshold: 0.1,
            minimumAffectedSessions: 3,
          },
        },
      });
      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(mockEvaluateDispatchHealth).toHaveBeenCalledTimes(1);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('sets the 10-second statement timeout before detector SQL', async () => {
    const events: string[] = [];
    const execute = jest.fn().mockImplementation(async () => {
      events.push('execute');
      return { rows: [] };
    });
    mockEvaluateDispatchHealth.mockImplementation(
      async (database: { execute: (query: unknown) => Promise<unknown> }) => {
        events.push('detector');
        await database.execute(sql`SELECT 1`);
        return { tripped: false };
      }
    );
    const transactionSpy = jest
      .spyOn(db, 'transaction')
      .mockImplementation(async callback => callback({ execute } as never));

    try {
      const response = await GET(makeRequest(HEALTH_CHECK_KEY));

      expect(response.status).toBe(200);
      expect(events).toEqual(['execute', 'detector', 'execute']);
      expect(execute).toHaveBeenCalledTimes(2);
      const timeoutQuery = new PgDialect().sqlToQuery(execute.mock.calls[0][0]).sql;
      expect(timeoutQuery).toBe("SET LOCAL statement_timeout = '10000'");
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('captures transaction failures and fails open without exposing the error', async () => {
    const errorMessage = 'database credentials leaked in error';
    const transactionSpy = jest.spyOn(db, 'transaction').mockRejectedValue(new Error(errorMessage));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();

    try {
      const response = await GET(makeRequest(HEALTH_CHECK_KEY));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        healthy: true,
        alerts: [],
        metadata: {
          timestamp: expect.any(String),
          runbookUrl: CLOUD_AGENT_DISPATCH_RUNBOOK_URL,
          evaluationStatus: 'failed_open',
          detector: {
            cohortWindowMinutes: 15,
            dispatchGraceMinutes: 5,
            stuckRateThreshold: 0.1,
            minimumAffectedSessions: 3,
          },
        },
      });
      expect(JSON.stringify(body)).not.toContain(errorMessage);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException.mock.calls[0][1]).toEqual({
        tags: {
          endpoint: 'cloud-agent/dispatch-health',
          source: 'cloud_agent_dispatch_health_check',
          detector: 'stuck_dispatch_rate',
        },
      });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      transactionSpy.mockRestore();
    }
  });

  it('returns one ticket alert when the detector trips', async () => {
    mockEvaluateDispatchHealth.mockResolvedValue({
      tripped: true,
      details: {
        eligibleRunCount: 30,
        stuckRunCount: 3,
        affectedSessionCount: 3,
        stuckRate: 0.1,
        oldestStuckQueuedAt: '2040-06-10T11:46:00.000Z',
      },
    });
    const transactionSpy = jest.spyOn(db, 'transaction').mockImplementation(async callback => {
      const execute = jest.fn().mockResolvedValue({ rows: [] });
      return callback({ execute } as never);
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    try {
      const response = await GET(makeRequest(HEALTH_CHECK_KEY));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        healthy: false,
        alerts: [
          {
            kind: 'stuck_dispatch_rate',
            label: 'Stuck Dispatch Rate',
            severity: 'ticket',
            eligibleRunCount: 30,
            stuckRunCount: 3,
            affectedSessionCount: 3,
            stuckRate: 0.1,
            oldestStuckQueuedAt: '2040-06-10T11:46:00.000Z',
            runbookUrl: CLOUD_AGENT_DISPATCH_RUNBOOK_URL,
          },
        ],
        metadata: {
          timestamp: expect.any(String),
          runbookUrl: CLOUD_AGENT_DISPATCH_RUNBOOK_URL,
          evaluationStatus: 'completed',
          detector: {
            cohortWindowMinutes: 15,
            dispatchGraceMinutes: 5,
            stuckRateThreshold: 0.1,
            minimumAffectedSessions: 3,
          },
        },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '[cloud-agent/dispatch-health] returning 503: detector tripped',
        {
          eligibleRunCount: 30,
          stuckRunCount: 3,
          affectedSessionCount: 3,
          stuckRate: 0.1,
          oldestStuckQueuedAt: '2040-06-10T11:46:00.000Z',
        }
      );
    } finally {
      warnSpy.mockRestore();
      transactionSpy.mockRestore();
    }
  });
});
