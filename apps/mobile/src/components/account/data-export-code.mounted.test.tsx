import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { DataExportScreen } from './data-export-screen';
import type * as ReactQuery from '@tanstack/react-query';

type Export = {
  id: string;
  status: string;
  requestedAt: string;
  failureMessage: string | null;
};

/** The callbacks a screen hands to `mutationOptions`, invoked by a test. */
type Handlers = {
  onSuccess?: (result: unknown, input: unknown) => void;
  onError?: (error: Error) => void;
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

vi.mock('react-native', () => ({ View: 'View' }));
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
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));

const BUTTON = 'Button' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

function handlersFor(kind: string): Handlers {
  const handlers = state.mutations[kind];
  if (!handlers) {
    throw new Error(`no ${kind} mutation was created`);
  }
  return handlers as Handlers;
}

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

function codeField(root: ReactTestRenderer['root']) {
  const [field] = root.findAll(node => Object.is(node.type, 'FormField'));
  if (!field) {
    throw new Error('missing download code field');
  }
  return field;
}

function texts(root: ReactTestRenderer['root']) {
  return root.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children);
}

/** The ready row every code-entry test starts from. */
const READY_EXPORT: Export = {
  id: 'export-2',
  status: 'ready',
  requestedAt: '2026-11-11T10:00:00Z',
  failureMessage: null,
};

const CODE_SENT = { challengeId: 'challenge-1', expiresInMinutes: 15 };

/**
 * Requests the download code for the ready export and settles the answer, which
 * is the state every code-entry test starts from.
 */
function openCodeStep(root: ReactTestRenderer['root']): void {
  act(() => {
    (button(root, 'Get code').props.onPress as () => void)();
  });
  act(() => {
    handlersFor('requestCode').onSuccess?.(CODE_SENT, { exportId: 'export-2' });
  });
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

describe('DataExportScreen code entry', () => {
  it('asks for a code and shows the field once it is sent', async () => {
    state.exports = [READY_EXPORT];
    const root = await mount();

    act(() => {
      (button(root, 'Get code').props.onPress as () => void)();
    });
    expect(state.calls).toEqual([{ name: 'requestCode', input: { exportId: 'export-2' } }]);
    expect(root.findAll(node => Object.is(node.type, 'FormField'))).toHaveLength(0);

    act(() => {
      handlersFor('requestCode').onSuccess?.(CODE_SENT, { exportId: 'export-2' });
    });

    expect(root.findAll(node => Object.is(node.type, 'FormField'))).toHaveLength(1);
  });

  it('sends the entered code to exchange for the download', async () => {
    state.exports = [READY_EXPORT];
    const root = await mount();

    openCodeStep(root);
    act(() => {
      (codeField(root).props.onChangeText as (value: string) => void)('12345678');
    });
    act(() => {
      (button(root, 'Download file').props.onPress as () => void)();
    });

    expect(state.calls.at(-1)).toEqual({
      name: 'download',
      input: { exportId: 'export-2', code: '12345678', challengeId: 'challenge-1' },
    });
  });

  it('refuses a code that is not eight digits', async () => {
    state.exports = [READY_EXPORT];
    const root = await mount();

    openCodeStep(root);
    act(() => {
      (codeField(root).props.onChangeText as (value: string) => void)('1234');
    });
    act(() => {
      (button(root, 'Download file').props.onPress as () => void)();
    });

    expect(state.calls.at(-1)?.name).toBe('requestCode');
    expect(state.toastError).toHaveBeenCalledWith('Enter the code from the email.');
  });

  it('never renders the request schema payload when the server rejects a code', async () => {
    state.exports = [READY_EXPORT];
    const root = await mount();

    openCodeStep(root);
    act(() => {
      handlersFor('download').onError?.(new Error('[{"code":"invalid_format","path":["code"]}]'));
    });

    expect(texts(root)).toContain('Enter the code from the email.');
    expect(texts(root)).not.toContainEqual(expect.stringContaining('invalid_format'));
  });

  it('shows a rejected code beside the field', async () => {
    state.exports = [READY_EXPORT];
    const root = await mount();

    openCodeStep(root);
    act(() => {
      handlersFor('download').onError?.(new Error('That code has expired'));
    });

    expect(texts(root)).toContain('That code has expired');
  });
});
