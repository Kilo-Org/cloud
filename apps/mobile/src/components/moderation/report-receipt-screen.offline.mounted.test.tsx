import { onlineManager } from '@tanstack/react-query';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { flushQueryUpdates } from '@/lib/active-sessions-live-sync.test-helpers';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

import { ReportReceiptScreen } from './report-receipt-screen';

/*
 * The receipt read is the screen's only source of content, and it is a first
 * load on a cold link: nothing is cached for a receipt this session never
 * opened. This suite mounts the real screen against a real `QueryClient` and
 * `onlineManager`, so the read's `networkMode` is whatever the screen asks for.
 * On the default `'online'` a first read while the device reports offline is
 * paused: `isPending` never leaves, so the skeleton stays on screen with no
 * error, no retry and no offline naming. `SETTLE_WHILE_OFFLINE` sends the read
 * instead, and its transport rejection settles the screen into the retryable
 * failure face.
 */

const RECEIPT_ID = '11111111-1111-4111-8111-111111111111';

const state = vi.hoisted(() => ({
  params: { 'receipt-id': '11111111-1111-4111-8111-111111111111' },
  connectivity: 'offline' as 'online' | 'offline' | 'unknown',
  receipt: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  useColorScheme: () => 'light',
  Alert: { alert: vi.fn() },
}));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => state.params }));
// The read's failure face and the invalid-link state are stubs: this suite
// proves which branch renders and what the read did, not their internals.
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', Copy: 'Copy' }));
vi.mock('@/lib/haptics', () => ({ selectionHaptic: vi.fn() }));
vi.mock('@/components/agents/use-message-copy', () => ({ performCopy: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => state.connectivity,
}));
// The read stays the real `useQuery` from the provider; only its options come
// from here, so the screen's own network mode decides what happens offline.
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    moderation: {
      getReportReceipt: {
        queryKey: (input: { receiptId: string }) => [
          ['moderation', 'getReportReceipt'],
          { input, type: 'query' },
        ],
        queryOptions: (input: { receiptId: string }) => ({
          queryKey: [['moderation', 'getReportReceipt'], { input, type: 'query' }],
          queryFn: () => state.receipt(),
        }),
      },
      appealReport: { mutationOptions: (options: unknown) => options },
    },
  }),
}));

type Renderer = ReactTestRenderer;

let tree: RenderWithProvidersResult | undefined = undefined;

async function mount(): Promise<Renderer> {
  tree = await renderWithProviders(createElement(ReportReceiptScreen));
  return tree.renderer;
}

function queryErrors(renderer: Renderer) {
  return renderer.root.findAll(node => Object.is(node.type, 'QueryError'));
}

/** The invalid-link branch renders one node of this type; its props carry no testID. */
function invalidLinks(renderer: Renderer) {
  return renderer.root.findAll(node => Object.is(node.type, 'InvalidRouteState'));
}

/** The query notifications a settle schedules land in a timer, so flush inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    await flushQueryUpdates();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.params = { 'receipt-id': RECEIPT_ID };
  state.connectivity = 'offline';
  state.receipt.mockReset();
});

afterEach(() => {
  tree?.unmount();
  tree = undefined;
  onlineManager.setOnline(true);
});

describe('ReportReceiptScreen on a dropped connection', () => {
  it('sends the cold read and settles it into the retryable failure face', async () => {
    state.receipt.mockImplementation(() => Promise.reject(new Error('Network request failed')));

    act(() => {
      onlineManager.setOnline(false);
    });
    const renderer = await mount();
    await settle();
    await settle();

    // The attempt, not a paused read: the read was sent while the manager
    // reported offline, and its rejection is what the screen settled on.
    expect(state.receipt).toHaveBeenCalledTimes(1);
    const [failure] = queryErrors(renderer);
    expect(failure).toBeDefined();
    expect(failure?.props.variant).toBe('offline');
    expect(failure?.props.onRetry).toBeTypeOf('function');
    expect(invalidLinks(renderer)).toHaveLength(0);
  });

  it('keeps the invalid-link state for a receipt the server does not hold', async () => {
    const notFound = Object.assign(
      new Error('No receipt with that id'),
      { name: 'TRPCClientError', data: { code: 'NOT_FOUND' } },
      { shape: { data: { code: 'NOT_FOUND' } } }
    );
    state.receipt.mockImplementation(() => Promise.reject(notFound));
    state.connectivity = 'online';

    act(() => {
      onlineManager.setOnline(false);
    });
    const renderer = await mount();
    await settle();
    await settle();

    expect(queryErrors(renderer)).toHaveLength(0);
    expect(invalidLinks(renderer)).toHaveLength(1);
  });

  it('renders the receipt once the read answers', async () => {
    state.receipt.mockResolvedValue({
      receiptId: RECEIPT_ID,
      triageStatus: 'actioned',
      appealStatus: 'none',
    });

    const renderer = await mount();
    await settle();

    expect(queryErrors(renderer)).toHaveLength(0);
    const texts = renderer.root
      .findAll(node => Object.is(node.type, 'Text'))
      .map(node => {
        const children = Array.isArray(node.props.children)
          ? node.props.children
          : [node.props.children];
        return children.filter((child: unknown) => typeof child === 'string').join('');
      });
    expect(texts).toEqual(expect.arrayContaining([RECEIPT_ID]));
  });

  it('names the deadline for a read that ran out of time', async () => {
    state.receipt.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error('Control-plane request timed out'), {
          name: 'TRPCClientError',
          data: { code: 'TIMEOUT', message: 'Control-plane request timed out' },
        })
      )
    );

    const renderer = await mount();
    await settle();
    await settle();

    const [failure] = queryErrors(renderer);
    expect(failure?.props.variant).toBe('timeout');
    expect(failure?.props.onRetry).toBeTypeOf('function');
  });

  it('names the refusal and offers no retry for a failure asking again cannot fix', async () => {
    // A refusal is a server answer, so the connection is settled online; on a
    // confirmed-offline device the shared classifier names the connection,
    // which is the case above.
    state.connectivity = 'online';
    state.receipt.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error('Forbidden'), {
          name: 'TRPCClientError',
          data: { code: 'FORBIDDEN', message: 'Forbidden' },
        })
      )
    );

    const renderer = await mount();
    await settle();
    await settle();

    const [failure] = queryErrors(renderer);
    expect(failure?.props.variant).toBe('permission');
    expect(failure?.props.onRetry).toBeUndefined();
  });
});
