import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminFetch } from '@/lib/admin/admin-fetch';
import { SafetyIdentifiersBackfill } from './SafetyIdentifiersBackfill';

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
  useMutation: jest.fn(),
  useQueryClient: jest.fn(),
}));
jest.mock('@/lib/admin/admin-fetch', () => ({ adminFetch: jest.fn() }));

Object.assign(globalThis, { React });

const mockUseQuery = jest.mocked(useQuery);
const mockUseMutation = jest.mocked(useMutation);

function mockCounts(missing: number) {
  mockUseQuery.mockReturnValue({
    data: { missing },
    isLoading: false,
    error: null,
  } as ReturnType<typeof useQuery>);
}

function render() {
  return renderToStaticMarkup(React.createElement(SafetyIdentifiersBackfill));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCounts(1_234);
  mockUseMutation.mockReturnValue({
    mutate: jest.fn(),
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useMutation>);
  jest.mocked(useQueryClient).mockReturnValue({
    invalidateQueries: jest.fn(),
  } as unknown as ReturnType<typeof useQueryClient>);
});

it('shows the missing count and enables the backfill button', () => {
  const html = render();

  expect(html).toContain(`${(1_234).toLocaleString()} missing`);
  expect(html).toContain('Backfill next 50 000');
  expect(html).not.toContain('disabled=""');
});

it('disables the button when every identifier is filled', () => {
  mockCounts(0);

  const html = render();

  expect(html).toContain('All filled');
  expect(html).toContain('Nothing to do');
  expect(html).toContain('disabled=""');
});

it('shows status errors instead of a misleading missing count', () => {
  mockUseQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: new Error('Could not load backfill status (HTTP 503)'),
  } as ReturnType<typeof useQuery>);

  const html = render();

  expect(html).toContain('Status unavailable');
  expect(html).toContain('Could not load backfill status (HTTP 503)');
  expect(html).not.toContain('missing</');
  expect(html).toContain('disabled=""');
});

it('shows the backfill request error', () => {
  mockUseMutation.mockReturnValue({
    mutate: jest.fn(),
    isPending: false,
    isError: true,
    error: new Error('OPENROUTER_ORG_ID is not configured on this server'),
  } as unknown as ReturnType<typeof useMutation>);

  expect(render()).toContain('OPENROUTER_ORG_ID is not configured on this server');
});

it('rejects failed status requests', async () => {
  render();
  jest.mocked(adminFetch).mockResolvedValue(new Response(null, { status: 503 }));
  const queryFn = mockUseQuery.mock.calls[0][0].queryFn;
  if (typeof queryFn !== 'function') throw new Error('Expected a status query function');

  await expect(queryFn({} as Parameters<typeof queryFn>[0])).rejects.toThrow(
    'Could not load backfill status (HTTP 503)'
  );
});
