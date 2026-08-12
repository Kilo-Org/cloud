import { describe, expect, test } from '@jest/globals';
import { revenueDashboardStatus } from './revenue-dashboard-status';
import type { RevenueKpiResponse } from '@/lib/revenueKpi';

const emptyResponse = { data: [] } as unknown as RevenueKpiResponse;
const readyResponse = { data: [{ date: '2026-08-11' }] } as unknown as RevenueKpiResponse;

describe('revenueDashboardStatus', () => {
  test('treats an empty daily series as empty, not an error', () => {
    expect(
      revenueDashboardStatus({
        isLoading: false,
        error: null,
        data: emptyResponse,
      })
    ).toBe('empty');
  });

  test('keeps fetch failures as errors', () => {
    expect(
      revenueDashboardStatus({
        isLoading: false,
        error: new Error('Failed to fetch daily revenue statistics'),
        data: undefined,
      })
    ).toBe('error');
  });

  test('treats a missing response without an error as loading', () => {
    expect(
      revenueDashboardStatus({
        isLoading: false,
        error: null,
        data: undefined,
      })
    ).toBe('loading');
  });

  test('is ready when the series has rows', () => {
    expect(
      revenueDashboardStatus({
        isLoading: false,
        error: null,
        data: readyResponse,
      })
    ).toBe('ready');
  });
});
