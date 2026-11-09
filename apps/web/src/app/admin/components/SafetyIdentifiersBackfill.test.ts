import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminFetch } from '@/lib/admin/admin-fetch';
import type { SafetyIdentifierStatusResponse } from '../api/safety-identifiers/route';
import { SafetyIdentifiersBackfill } from './SafetyIdentifiersBackfill';

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
  useMutation: jest.fn(),
  useQueryClient: jest.fn(),
}));
jest.mock('@/lib/admin/admin-fetch', () => ({ adminFetch: jest.fn() }));

const mockUseQuery = jest.mocked(useQuery);
const mockUseMutation = jest.mocked(useMutation);

let status: SafetyIdentifierStatusResponse;

beforeEach(() => {
  jest.clearAllMocks();
  status = {
    running: false,
    batchSize: 5_000,
    scheduleMinutes: 3,
    backfill: {
      status: 'running',
      processed: 10,
      total: 20,
      cursor: 'oauth/synthetic-user',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:03:00.000Z',
      completedAt: null,
      lastBatchProcessed: 10,
      lastError: null,
    },
  };
  mockUseQuery.mockReturnValue({
    data: status,
    isLoading: false,
    error: null,
  } as ReturnType<typeof useQuery>);
  mockUseMutation.mockReturnValue({
    mutate: jest.fn(),
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useMutation>);
  jest.mocked(useQueryClient).mockReturnValue({
    invalidateQueries: jest.fn(),
  } as unknown as ReturnType<typeof useQueryClient>);
});

it('shows persisted progress and keeps manual regeneration enabled between batches', () => {
  const html = renderToStaticMarkup(React.createElement(SafetyIdentifiersBackfill));

  expect(html).toContain('Waiting for next batch');
  expect(html).toContain('10 / 20');
  expect(html).toContain('oauth/synthetic-user');
  expect(html).toContain('Run next batch');
  expect(html).not.toContain('disabled=""');
  expect(mockUseQuery).toHaveBeenCalledWith(expect.objectContaining({ refetchInterval: 15_000 }));
});

it('disables manual batches while a scheduled batch holds the lock', () => {
  status.running = true;

  const html = renderToStaticMarkup(React.createElement(SafetyIdentifiersBackfill));

  expect(html).toContain('Batch running');
  expect(html).toContain('disabled=""');
});

it('disables manual regeneration after persistent completion', () => {
  status.backfill.status = 'completed';
  status.backfill.completedAt = '2026-01-01T00:06:00.000Z';

  const html = renderToStaticMarkup(React.createElement(SafetyIdentifiersBackfill));

  expect(html).toContain('Regeneration complete');
  expect(html).toContain('Completed at');
  expect(html).toContain('disabled=""');
});

it('surfaces a persisted batch failure without losing progress', () => {
  status.backfill.lastError = 'The last batch failed. The next batch will retry.';

  const html = renderToStaticMarkup(React.createElement(SafetyIdentifiersBackfill));

  expect(html).toContain(status.backfill.lastError);
  expect(html).toContain('10 / 20');
  expect(html).not.toContain('disabled=""');
});

it('shows status errors instead of a misleading missing count', () => {
  mockUseQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: new Error('Could not load backfill status'),
  } as ReturnType<typeof useQuery>);

  const html = renderToStaticMarkup(React.createElement(SafetyIdentifiersBackfill));

  expect(html).toContain('Status unavailable');
  expect(html).toContain('Could not load backfill status');
  expect(html).toContain('disabled=""');
});

it('rejects failed status requests', async () => {
  renderToStaticMarkup(React.createElement(SafetyIdentifiersBackfill));
  jest.mocked(adminFetch).mockResolvedValue(new Response(null, { status: 503 }));
  const options = mockUseQuery.mock.calls[0][0];
  const queryFn = options.queryFn;
  if (typeof queryFn !== 'function') throw new Error('Expected a status query function');

  await expect(queryFn({} as Parameters<typeof queryFn>[0])).rejects.toThrow(
    'Could not load backfill status (HTTP 503)'
  );
});
