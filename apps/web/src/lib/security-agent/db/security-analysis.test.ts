import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { inspect } from 'util';
import type * as analysisDbModule from './security-analysis';

const mockReturning: jest.Mock = jest.fn();
const mockWhere: jest.Mock = jest.fn(() => ({ returning: mockReturning }));
const mockSet: jest.Mock = jest.fn(() => ({ where: mockWhere }));
const mockUpdate: jest.Mock = jest.fn(() => ({ set: mockSet }));
const mockCaptureException: jest.Mock = jest.fn();

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    update: mockUpdate,
  },
}));

jest.mock('@sentry/nextjs', () => ({ captureException: mockCaptureException }));

let cleanupStaleAnalyses: typeof analysisDbModule.cleanupStaleAnalyses;
let enqueueBacklogFindings: typeof analysisDbModule.enqueueBacklogFindings;
let updateAnalysisStatus: typeof analysisDbModule.updateAnalysisStatus;

beforeAll(async () => {
  ({ cleanupStaleAnalyses, enqueueBacklogFindings, updateAnalysisStatus } =
    await import('./security-analysis'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockReturning.mockImplementation(async () => []);
});

describe('cleanupStaleAnalyses', () => {
  it('adds anti-join exclusion for queue-owned pending/running rows', async () => {
    await cleanupStaleAnalyses(30);

    expect(mockWhere).toHaveBeenCalledTimes(1);
    const whereArg = mockWhere.mock.calls[0][0];
    const serialized = inspect(whereArg, { depth: 10 });
    expect(serialized).toContain('security_analysis_queue');
    expect(serialized).toContain('pending');
    expect(serialized).toContain('running');
  });
});

describe('retired web sync queue policy surface', () => {
  it('does not expose obsolete sync queue policy helpers', async () => {
    const analysisDb = await import('./security-analysis');

    expect('getOwnerAutoAnalysisEnabledAt' in analysisDb).toBe(false);
    expect('isFindingEligibleForAutoAnalysis' in analysisDb).toBe(false);
    expect('syncAutoAnalysisQueueForFinding' in analysisDb).toBe(false);
    expect('dequeueSupersededFindings' in analysisDb).toBe(false);
  });
});

describe('updateAnalysisStatus telemetry', () => {
  it('captures the update field names without their values', async () => {
    mockReturning.mockImplementationOnce(async () => {
      throw new Error('update failed');
    });

    await expect(
      updateAnalysisStatus('finding-1', 'running', {
        sessionId: 'session-1',
        error: 'analysis error sentinel',
        analysis: {
          sandboxAnalysis: { rawMarkdown: 'analysis content sentinel' },
        } as never,
      })
    ).rejects.toThrow('update failed');

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [, context] = mockCaptureException.mock.calls[0] as [
      unknown,
      { tags: Record<string, string>; extra: Record<string, unknown> },
    ];
    expect(context).toEqual({
      tags: { operation: 'updateAnalysisStatus' },
      extra: {
        findingId: 'finding-1',
        status: 'running',
        updatedFields: ['sessionId', 'error', 'analysis'],
      },
    });
    expect(JSON.stringify(context)).not.toContain('sentinel');
  });
});

describe('enqueueBacklogFindings', () => {
  it('writes admitted_config_revision into the queue rows', async () => {
    const mockExecute = jest.fn(async (_query: unknown) => ({ rows: [{ id: 'a' }, { id: 'b' }] }));

    const count = await enqueueBacklogFindings({
      owner: { userId: 'user-1' },
      autoAnalysisMinSeverity: 'high',
      tx: { execute: mockExecute } as never,
      admittedConfigRevision: 7,
    });

    expect(count).toBe(2);
    const serialized = inspect(mockExecute.mock.calls[0]?.[0], { depth: 10 });
    expect(serialized).toContain('admitted_config_revision');
    expect(serialized).toContain('7');
  });
});
