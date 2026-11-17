import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { DataExportScreen } from './data-export-screen';
import { ExportRow } from './data-export-row';
import type * as ReactQuery from '@tanstack/react-query';

type Export = {
  id: string;
  status: string;
  requestedAt: string;
  failureMessage: string | null;
};

type ScreenState = {
  access: { enabled: boolean };
  accessError: boolean;
  exports: Export[];
  listError: boolean;
  mutations: Record<string, unknown>;
  calls: { name: string; input: unknown }[];
  pending: string;
  toastError: Mock;
};

const state = vi.hoisted((): ScreenState => ({
  access: { enabled: true },
  accessError: false,
  exports: [],
  listError: false,
  mutations: {},
  calls: [],
  pending: '',
  toastError: vi.fn(),
}));

/** Records the callbacks one mutation is created with, and names its mutate call. */
function record(kind: string) {
  return (options: unknown) => {
    state.mutations[kind] = options;
    state.pending = kind;
    return {};
  };
}

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  useColorScheme: () => 'light',
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
}));
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works; only the
  // hooks the screen calls are replaced.
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQuery: (options: { kind: string }) => {
      if (options.kind === 'access') {
        return {
          data: state.access,
          isPending: false,
          isError: state.accessError,
          isFetching: false,
          refetch: vi.fn(),
        };
      }
      return {
        data: { exports: state.exports },
        isPending: false,
        isError: state.listError,
        isFetching: false,
        refetch: vi.fn(),
      };
    },
    useMutation: () => {
      const kind = state.pending;
      return {
        mutate: (input: unknown) => {
          state.calls.push({ name: kind, input });
        },
        isPending: false,
        variables: undefined,
      };
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
vi.mock('@/lib/data-export-download', () => ({
  shareDataExport: vi.fn(),
  getDataExportFailureMessage: () => 'Download failed',
}));
vi.mock('@/lib/format', () => ({ formatDate: () => 'Nov 12, 2026' }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    userExports: {
      uiAccess: { queryOptions: () => ({ kind: 'access' }) },
      list: { queryOptions: () => ({ kind: 'list' }), queryKey: () => [] },
      request: { mutationOptions: record('request') },
      requestDownloadCode: { mutationOptions: record('requestCode') },
      createDownload: { mutationOptions: record('download') },
    },
  }),
}));
vi.mock('@/components/ui/icons', () => ({
  Archive: 'Archive',
  FileText: 'FileText',
  Share: 'Share',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));

const BUTTON = 'Button' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(DataExportScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

function button(root: ReactTestRenderer['root'], label: string) {
  const found = root.findAll(
    node =>
      Object.is(node.type, BUTTON) &&
      node.findAll(child => child.props.children === label).length > 0
  );
  const [first] = found;
  if (!first) {
    throw new Error(`missing ${label} button`);
  }
  return first;
}

function texts(root: ReactTestRenderer['root']) {
  return root.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children);
}

/** The ready row every download test starts from. */
function readyExport(): Export[] {
  return [
    { id: 'export-2', status: 'ready', requestedAt: '2026-11-11T10:00:00Z', failureMessage: null },
  ];
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.access = { enabled: true };
  state.accessError = false;
  state.exports = [];
  state.listError = false;
  state.mutations = {};
  state.calls = [];
  state.pending = '';
  state.toastError.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('DataExportScreen', () => {
  it('requests an export from the empty list', async () => {
    const root = await mount();

    expect(
      root.findAll(node => Object.is(node.type, 'EmptyState')).map(node => node.props.title)
    ).toEqual(['No exports yet']);

    act(() => {
      (button(root, 'Request export').props.onPress as () => void)();
    });

    expect(state.calls).toEqual([{ name: 'request', input: undefined }]);
  });

  it('offers the download code only for a ready export', async () => {
    state.exports = [
      {
        id: 'export-1',
        status: 'processing',
        requestedAt: '2026-11-12T10:00:00Z',
        failureMessage: null,
      },
      ...readyExport(),
    ];
    const root = await mount();

    expect(button(root, 'Get code')).toBeDefined();
    expect(texts(root)).toEqual(expect.arrayContaining(['Preparing', 'Ready to download']));
  });

  it('shows a rejected code request under the list while no challenge is open', async () => {
    state.exports = readyExport();
    const root = await mount();

    act(() => {
      (root.findByType(ExportRow).props.onRequestCode as () => void)();
    });
    expect(state.calls).toEqual([{ name: 'requestCode', input: { exportId: 'export-2' } }]);

    act(() => {
      (state.mutations.requestCode as { onError: (error: unknown) => void }).onError(
        new Error('Too many codes requested.')
      );
    });

    // The message renders where the request was raised, with no code field on
    // screen: the old copy could only paint inside the open challenge.
    expect(texts(root)).toContain('Too many codes requested.');
    expect(root.findAll(node => Object.is(node.type, 'FormField'))).toHaveLength(0);
  });

  it('uses the generic retry line when the code request fails without a readable reason', async () => {
    state.exports = readyExport();
    const root = await mount();

    act(() => {
      (root.findByType(ExportRow).props.onRequestCode as () => void)();
    });
    act(() => {
      (state.mutations.requestCode as { onError: (error: unknown) => void }).onError({
        data: { code: 'BAD_REQUEST' },
      });
    });

    // The entry-field copy would name a field that is not on screen yet.
    expect(texts(root)).toContain(i18n.t('queryError.neutralDescription'));
    expect(texts(root)).not.toContain(i18n.t('profile.dataExport.codeRequired'));
  });

  it('surfaces the server reason for a failed export', async () => {
    state.exports = [
      {
        id: 'export-3',
        status: 'failed',
        requestedAt: '2026-11-12T10:00:00Z',
        failureMessage: 'The artifact could not be produced',
      },
    ];
    const root = await mount();

    expect(texts(root)).toContain('The artifact could not be produced');
  });

  it('explains when the feature is not released to this account', async () => {
    state.access = { enabled: false };
    const root = await mount();

    expect(
      root.findAll(node => Object.is(node.type, 'EmptyState')).map(node => node.props.title)
    ).toEqual([i18n.t('profile.dataExport.unavailableTitle')]);
    expect(root.findAll(node => Object.is(node.type, BUTTON))).toHaveLength(0);
  });

  it('keeps a retry when the release check fails', async () => {
    state.accessError = true;
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(1);
  });

  it('keeps a retry when the export list fails', async () => {
    state.listError = true;
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(1);
  });
});
