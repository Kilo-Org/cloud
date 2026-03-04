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

beforeAll(async () => {
  ({ cleanupStaleAnalyses } = await import('./security-analysis'));
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
