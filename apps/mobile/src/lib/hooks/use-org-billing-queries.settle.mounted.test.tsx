// The request-log window's read settles while the device reports offline
// instead of pausing: a paused first read leaves the window skeleton on screen
// with no request sent and no retry offered. The `@/lib/trpc` seam is mocked so
// the case drives the transport answer directly, the same way the
// `useCurrentUserId` suite does it.

import { onlineManager } from '@tanstack/react-query';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

import { useOrgRequestLogs } from './use-org-billing-queries';

/** The options object the hook hands `queryOptions`, as this module sees it. */
type ReadOptions = { enabled?: boolean; networkMode?: string; refetchOnReconnect?: boolean };

/** What the probe records; the fields these cases assert on. */
type RequestLogsRead = {
  data: unknown;
  isError: boolean;
  isPending: boolean;
};

const START_TIME = '2026-01-01T00:00:00.000Z';

const state = vi.hoisted(() => ({
  request: vi.fn<() => Promise<unknown>>(),
  options: [] as ReadOptions[],
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {},
  useTRPC: () => ({
    organizations: {
      requestLogs: {
        list: {
          queryOptions: (input: unknown, options: ReadOptions) => {
            state.options.push(options);
            return {
              queryKey: ['organizations.requestLogs.list', input],
              queryFn: state.request,
              ...options,
            };
          },
        },
      },
    },
  }),
}));

let latest: RequestLogsRead | undefined = undefined;
let tree: RenderWithProvidersResult | undefined = undefined;

/** The hook's value as of the last committed render. */
function Probe(): null {
  const read = useOrgRequestLogs('org-1', START_TIME, true);
  latest = { data: read.data, isError: read.isError, isPending: read.isPending };
  return null;
}

function current(): RequestLogsRead {
  if (!latest) {
    throw new Error('Missing hook result');
  }
  return latest;
}

async function render(): Promise<void> {
  tree = await renderWithProviders(createElement(Probe));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onlineManager.setOnline(true);
  state.request.mockReset();
  state.options = [];
  latest = undefined;
});

afterEach(() => {
  tree?.unmount();
  tree = undefined;
  latest = undefined;
  onlineManager.setOnline(true);
});

describe('useOrgRequestLogs offline read', () => {
  it('settles the window offline instead of pausing it', async () => {
    onlineManager.setOnline(false);
    state.request.mockRejectedValue(new TypeError('Network request failed'));

    await render();
    // The read carries `SETTLE_WHILE_OFFLINE`, so the attempt was issued while
    // the manager reported offline; a paused read would have called nothing.
    expect(state.request).toHaveBeenCalledTimes(1);

    await waitFor(() => current().isError);
    expect(current().isError).toBe(true);
    // Settled, not pending: the skeleton is replaced by the failure body.
    expect(current().isPending).toBe(false);
    expect(current().data).toBeUndefined();

    // The reconnect refetch the settle policy also re-enables is part of the
    // read's options, so the window recovers when the connection returns.
    expect(state.options.at(-1)).toMatchObject({
      enabled: true,
      networkMode: 'always',
      refetchOnReconnect: true,
    });
  });
});
