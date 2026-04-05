import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { inspect } from 'util';
import type * as analysisDbModule from './security-analysis';

const mockReturning: jest.Mock = jest.fn();
const mockWhere: jest.Mock = jest.fn(() => ({ returning: mockReturning }));
const mockSet: jest.Mock = jest.fn(() => ({ where: mockWhere }));
const mockUpdate: jest.Mock = jest.fn(() => ({ set: mockSet }));

jest.mock('@/lib/drizzle', () => ({
  db: {
    update: mockUpdate,
  },
}));

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

let cleanupStaleAnalyses: typeof analysisDbModule.cleanupStaleAnalyses;
let isFindingEligibleForAutoAnalysis: typeof analysisDbModule.isFindingEligibleForAutoAnalysis;

beforeAll(async () => {
  ({ cleanupStaleAnalyses, isFindingEligibleForAutoAnalysis } =
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

describe('isFindingEligibleForAutoAnalysis', () => {
  const baseParams = {
    findingCreatedAt: '2025-06-01T00:00:00Z',
    findingStatus: 'open',
    severity: 'high',
    ownerAutoAnalysisEnabledAt: '2025-07-01T00:00:00Z',
    isAgentEnabled: true,
    autoAnalysisEnabled: true,
    autoAnalysisMinSeverity: 'high' as const,
  };

  it('rejects findings created before auto_analysis_enabled_at by default', () => {
    const result = isFindingEligibleForAutoAnalysis(baseParams);
    expect(result.eligible).toBe(false);
  });

  it('accepts findings created after auto_analysis_enabled_at', () => {
    const result = isFindingEligibleForAutoAnalysis({
      ...baseParams,
      findingCreatedAt: '2025-08-01T00:00:00Z',
    });
    expect(result.eligible).toBe(true);
  });

  it('accepts pre-existing findings when autoAnalysisIncludeExisting is true', () => {
    const result = isFindingEligibleForAutoAnalysis({
      ...baseParams,
      autoAnalysisIncludeExisting: true,
    });
    expect(result.eligible).toBe(true);
  });

  it('still rejects non-open findings even with autoAnalysisIncludeExisting', () => {
    const result = isFindingEligibleForAutoAnalysis({
      ...baseParams,
      findingStatus: 'fixed',
      autoAnalysisIncludeExisting: true,
    });
    expect(result.eligible).toBe(false);
  });

  it('still respects severity threshold with autoAnalysisIncludeExisting', () => {
    const result = isFindingEligibleForAutoAnalysis({
      ...baseParams,
      severity: 'low',
      autoAnalysisMinSeverity: 'high',
      autoAnalysisIncludeExisting: true,
    });
    expect(result.eligible).toBe(false);
  });

  it('rejects when agent is not enabled even with autoAnalysisIncludeExisting', () => {
    const result = isFindingEligibleForAutoAnalysis({
      ...baseParams,
      isAgentEnabled: false,
      autoAnalysisIncludeExisting: true,
    });
    expect(result.eligible).toBe(false);
  });

  it('treats null severity as eligible with low rank when threshold is "all"', () => {
    const result = isFindingEligibleForAutoAnalysis({
      ...baseParams,
      severity: null,
      autoAnalysisMinSeverity: 'all',
      findingCreatedAt: '2025-08-01T00:00:00Z',
    });
    expect(result.eligible).toBe(true);
    expect(result.severityRank).toBe(3);
  });

  it('rejects null severity when threshold is stricter than "all"', () => {
    const result = isFindingEligibleForAutoAnalysis({
      ...baseParams,
      severity: null,
      autoAnalysisMinSeverity: 'high',
      findingCreatedAt: '2025-08-01T00:00:00Z',
    });
    expect(result.eligible).toBe(false);
    expect(result.severityRank).toBe(3);
  });

  it('treats null severity as eligible when threshold is medium', () => {
    const result = isFindingEligibleForAutoAnalysis({
      ...baseParams,
      severity: null,
      autoAnalysisMinSeverity: 'medium',
      findingCreatedAt: '2025-08-01T00:00:00Z',
    });
    // low rank (3) > medium max rank (2), so not eligible
    expect(result.eligible).toBe(false);
    expect(result.severityRank).toBe(3);
  });
});
