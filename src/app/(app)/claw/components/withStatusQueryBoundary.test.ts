import { describe, expect, test } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { withStatusQueryBoundary } from '@/app/(app)/claw/components';

const baseStatus: KiloClawDashboardStatus = {
  userId: 'user-1',
  sandboxId: 'sandbox-1',
  status: 'running',
  provisionedAt: 1,
  lastStartedAt: 2,
  lastStoppedAt: 3,
  envVarCount: 1,
  secretCount: 2,
  channelCount: 3,
  flyAppName: null,
  flyMachineId: null,
  flyVolumeId: null,
  flyRegion: null,
  gatewayToken: 'token',
  workerUrl: 'https://claw.kilo.ai',
};

describe('withStatusQueryBoundary', () => {
  test('renders loading state when query is loading', () => {
    const Wrapped = withStatusQueryBoundary(
      ({ status }: { status: KiloClawDashboardStatus | undefined }) =>
        createElement('div', null, status?.status || 'none')
    );

    const html = renderToStaticMarkup(
      createElement(Wrapped, {
        statusQuery: {
          data: undefined,
          isLoading: true,
          error: null,
        },
      })
    );

    expect(html).toContain('Loading...');
  });

  test('renders error state when query has an error', () => {
    const Wrapped = withStatusQueryBoundary(
      ({ status }: { status: KiloClawDashboardStatus | undefined }) =>
        createElement('div', null, status?.status || 'none')
    );

    const html = renderToStaticMarkup(
      createElement(Wrapped, {
        statusQuery: {
          data: undefined,
          isLoading: false,
          error: new Error('network issue'),
        },
      })
    );

    expect(html).toContain('Failed to load:');
    expect(html).toContain('network issue');
  });

  test('renders wrapped component when query is resolved', () => {
    const Wrapped = withStatusQueryBoundary(
      ({ status }: { status: KiloClawDashboardStatus | undefined }) =>
        createElement('div', null, `status:${status?.status || 'none'}`)
    );

    const html = renderToStaticMarkup(
      createElement(Wrapped, {
        statusQuery: {
          data: baseStatus,
          isLoading: false,
          error: null,
        },
      })
    );

    expect(html).toContain('status:running');
  });
});
