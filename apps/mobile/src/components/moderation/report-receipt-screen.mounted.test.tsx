import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { ReportReceiptScreen } from './report-receipt-screen';
import type * as ReactQuery from '@tanstack/react-query';

const RECEIPT_ID = '11111111-1111-4111-8111-111111111111';

type MutationOptions = {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
};

type AlertButton = { text?: string; onPress?: () => void };

type Receipt = { receiptId: string; triageStatus: string; appealStatus: string };

type ScreenState = {
  params: Record<string, string>;
  receipt: Receipt;
  error: { data?: { code: string }; message?: string } | undefined;
  mutations: MutationOptions[];
  mutate: Mock;
  alert: Mock;
  toastError: Mock;
};

const state = vi.hoisted((): ScreenState => ({
  params: { 'receipt-id': '11111111-1111-4111-8111-111111111111' },
  receipt: {
    receiptId: '11111111-1111-4111-8111-111111111111',
    triageStatus: 'received',
    appealStatus: 'none',
  },
  error: undefined as { data?: { code: string }; message?: string } | undefined,
  mutations: [] as MutationOptions[],
  mutate: vi.fn(),
  alert: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View', Alert: { alert: state.alert } }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => state.params }));
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works; only the
  // hooks the screen calls are replaced.
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQuery: () => ({
      data: state.error ? undefined : state.receipt,
      isPending: false,
      isError: state.error !== undefined,
      isFetching: false,
      error: state.error,
      refetch: vi.fn(),
    }),
    useMutation: (options: MutationOptions) => {
      state.mutations.push(options);
      return { mutate: state.mutate, isPending: false };
    },
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});
vi.mock('sonner-native', () => ({
  toast: { error: state.toastError, success: vi.fn() },
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    moderation: {
      getReportReceipt: { queryOptions: () => ({}), queryKey: () => [] },
      appealReport: { mutationOptions: (options: MutationOptions) => options },
    },
  }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));

const BUTTON = 'Button' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(ReportReceiptScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

function texts(root: ReactTestRenderer['root']) {
  return root.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children);
}

function appealButton(root: ReactTestRenderer['root']) {
  const [button] = root.findAll(node => Object.is(node.type, BUTTON));
  return button;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.params = { 'receipt-id': RECEIPT_ID };
  state.receipt = { receiptId: RECEIPT_ID, triageStatus: 'received', appealStatus: 'none' };
  state.error = undefined;
  state.mutations = [];
  state.mutate.mockClear();
  state.alert.mockClear();
  state.toastError.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ReportReceiptScreen', () => {
  it('shows the receipt id, its triage state and the appeal state', async () => {
    const root = await mount();

    expect(texts(root)).toEqual(expect.arrayContaining([RECEIPT_ID, 'Received', 'None submitted']));
  });

  it('offers no appeal while the report is still being received', async () => {
    const root = await mount();

    expect(appealButton(root)).toBeUndefined();
  });

  it('asks before appealing, then submits the appeal once', async () => {
    state.receipt = { receiptId: RECEIPT_ID, triageStatus: 'actioned', appealStatus: 'none' };
    const root = await mount();

    const appeal = appealButton(root);
    if (!appeal) {
      throw new Error('missing appeal button');
    }
    act(() => {
      (appeal.props.onPress as () => void)();
    });

    expect(state.alert).toHaveBeenCalledTimes(1);
    expect(state.mutate).not.toHaveBeenCalled();

    const buttons = (state.alert.mock.calls[0]?.[2] ?? []) as AlertButton[];
    act(() => {
      buttons.at(-1)?.onPress?.();
    });

    expect(state.mutate).toHaveBeenCalledWith({ receiptId: RECEIPT_ID });
  });

  it('keeps the appeal button hidden once an appeal is in review', async () => {
    state.receipt = { receiptId: RECEIPT_ID, triageStatus: 'rejected', appealStatus: 'submitted' };
    const root = await mount();

    expect(texts(root)).toContain('Appeal in review');
    expect(appealButton(root)).toBeUndefined();
  });

  it('treats a receipt the server does not hold as an invalid link', async () => {
    state.error = { data: { code: 'NOT_FOUND' } };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'InvalidRouteState'))).toHaveLength(1);
  });

  it('keeps a retry for a failure that could pass', async () => {
    state.error = { message: 'Service unavailable' };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(1);
  });

  it('reports a refused appeal', async () => {
    state.receipt = { receiptId: RECEIPT_ID, triageStatus: 'actioned', appealStatus: 'none' };
    await mount();

    act(() => {
      state.mutations[0]?.onError?.(new Error('appeal_not_allowed'));
    });

    expect(state.toastError).toHaveBeenCalledWith('appeal_not_allowed');
  });

  it('treats a malformed receipt id as an invalid link without a query', async () => {
    state.params = { 'receipt-id': 'not-a-uuid' };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'InvalidRouteState'))).toHaveLength(1);
  });
});
