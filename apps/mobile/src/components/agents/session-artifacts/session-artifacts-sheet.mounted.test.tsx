/* eslint-disable max-lines -- one harness mounts the presentational body across its states and the container across its two actions; splitting them would duplicate the mock tree twice. */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake reads answer a promise the way a resolved request does, without an await of their own */
import { type ComponentProps, createElement, type ReactNode } from 'react';
import type * as ReactI18next from 'react-i18next';
import { toast } from 'sonner-native';
import { act, TestRenderer } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { formatFileSize } from '@/lib/format';

import {
  type ArtifactFailure,
  SessionArtifactsBody,
  type SessionArtifactsState,
} from './session-artifacts-body';
import {
  groupWorkspaceArtifactsByFolder,
  type WorkspaceArtifactEntry,
} from './session-artifacts-grouping';
import { SessionArtifactsSheet } from './session-artifacts-sheet';

const holder = vi.hoisted(() => ({
  /** The confirmation the container asked for, and the answer it expects. */
  confirm: null as {
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null,
  /** The entries the list read answers, and how many reads it has served. */
  entries: [] as unknown[],
  listReads: 0,
  listError: null as Error | null,
  sandboxStatus: 'active' as string,
  deleteResult: { status: 'deleted', revision: 2 } as unknown,
  deleteError: null as Error | null,
  downloadUrl: { url: 'https://example.com/artifact', expiresAt: 1_767_225_600_000 } as unknown,
  downloadError: null as Error | null,
  shareFailureKind: 'retry' as string,
  shareRemoteFile: vi.fn<(input: Record<string, unknown>) => Promise<void>>(),
  fetchList: vi.fn<() => Promise<unknown>>(),
  fetchSandbox: vi.fn<() => Promise<unknown>>(),
  deleteArtifact: vi.fn<(input: unknown) => Promise<unknown>>(),
  mintUrl: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock('@/lib/trpc', () => {
  const queryOptions =
    (scope: string, procedure: string, fetch: () => Promise<unknown>) =>
    (input: unknown, options?: Record<string, unknown>) => ({
      queryKey: [scope, procedure, input],
      queryFn: fetch,
      ...options,
    });
  return {
    useTRPC: () => ({
      cloudAgentNext: {
        listWorkspaceArtifacts: {
          queryOptions: queryOptions('personal', 'list', holder.fetchList),
        },
        getSandboxStatus: {
          queryOptions: queryOptions('personal', 'sandbox', holder.fetchSandbox),
        },
      },
      organizations: {
        cloudAgentNext: {
          listWorkspaceArtifacts: {
            queryOptions: queryOptions('organization', 'list', holder.fetchList),
          },
          getSandboxStatus: {
            queryOptions: queryOptions('organization', 'sandbox', holder.fetchSandbox),
          },
        },
      },
    }),
    trpcClient: {
      cloudAgentNext: {
        deleteWorkspaceArtifact: { mutate: holder.deleteArtifact },
        getWorkspaceArtifactDownloadUrl: { query: holder.mintUrl },
      },
      organizations: {
        cloudAgentNext: {
          deleteWorkspaceArtifact: { mutate: holder.deleteArtifact },
          getWorkspaceArtifactDownloadUrl: { query: holder.mintUrl },
        },
      },
    },
  };
});

vi.mock('@/lib/share-remote-file', () => ({
  shareRemoteFile: holder.shareRemoteFile,
  getShareFailureKind: () => holder.shareFailureKind,
}));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: i18n.t.bind(i18n) }),
  };
});

vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: {
      title: string;
      message: string;
      confirmLabel: string;
      onConfirm: () => void;
    }) => {
      holder.confirm = request;
    },
    dialog: null,
  }),
}));

vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/section-header', () => ({ SectionHeader: 'SectionHeader' }));
vi.mock('@/components/ui/icon-tile', () => ({ IconTile: 'IconTile' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { title?: string; action?: ReactNode }) =>
    createElement('EmptyState', props, props.action ?? null),
  StateAction: (props: { label: string; onPress: () => void }) =>
    createElement('StateAction', props),
}));
vi.mock('@/components/ui/row-group', () => ({
  RowGroup: (props: { children?: ReactNode }) => createElement('RowGroup', null, props.children),
}));
// The row's trailing slot is a prop, not a child, so the host stub paints it
// where the real frame does or the row's two actions would never mount.
vi.mock('@/components/ui/row-frame', () => ({
  RowFrame: (props: {
    children?: ReactNode;
    trailing?: { kind: string; nodes?: readonly ReactNode[] };
  }) =>
    createElement(
      'RowFrame',
      null,
      props.children,
      props.trailing?.kind === 'nodes' ? props.trailing.nodes : null
    ),
}));
vi.mock('@/components/ui/row-trailing', () => ({
  RowIconAction: (props: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
    children?: ReactNode;
  }) => createElement('RowIconAction', props, props.children),
}));
vi.mock('@/components/ui/icons', () => ({
  Archive: 'Archive',
  Cloud: 'Cloud',
  Download: 'Download',
  FileText: 'FileText',
  RotateCcw: 'RotateCcw',
  Trash2: 'Trash2',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666', destructive: '#dc2626' }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));

const CLOUD_AGENT_SESSION_ID = 'workspace_12345678-1234-4234-9234-123456789abc';

/** A saved file as the worker lists it. */
function entry(relativePath: string, sizeBytes: number, seed: number): WorkspaceArtifactEntry {
  return {
    relativePath,
    contentHash: seed.toString(16).padStart(64, '0'),
    sizeBytes,
    contentType: 'application/octet-stream',
    updatedAt: 1_767_225_600_000 + seed,
  };
}

const ENTRIES = [entry('reports/summary.pdf', 1_400_000, 1), entry('charts/q4.png', 812_000, 2)];

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

let renderer: Renderer | undefined = undefined;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
});

beforeEach(() => {
  holder.confirm = null;
  holder.entries = ENTRIES;
  holder.listReads = 0;
  holder.listError = null;
  holder.sandboxStatus = 'active';
  holder.deleteResult = { status: 'deleted', revision: 2 };
  holder.deleteError = null;
  holder.downloadUrl = { url: 'https://example.com/artifact', expiresAt: 1_767_225_600_000 };
  holder.downloadError = null;
  holder.shareFailureKind = 'retry';
  holder.shareRemoteFile.mockReset();
  holder.shareRemoteFile.mockImplementation(async () => undefined);
  holder.fetchList.mockReset();
  holder.fetchList.mockImplementation(async () => {
    if (holder.listError !== null) {
      throw holder.listError;
    }
    holder.listReads += 1;
    return { revision: holder.listReads, entries: holder.entries };
  });
  holder.fetchSandbox.mockReset();
  holder.fetchSandbox.mockImplementation(async () => ({ status: holder.sandboxStatus }));
  holder.deleteArtifact.mockReset();
  holder.deleteArtifact.mockImplementation(async () => {
    if (holder.deleteError !== null) {
      throw holder.deleteError;
    }
    return holder.deleteResult;
  });
  holder.mintUrl.mockReset();
  holder.mintUrl.mockImplementation(async () => {
    if (holder.downloadError !== null) {
      throw holder.downloadError;
    }
    return holder.downloadUrl;
  });
  vi.mocked(toast.error).mockReset();
});

/** The node, or a failure that says which one the tree did not draw. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not rendered`);
  }
  return value;
}

function texts(root: Instance): string[] {
  return nodesOfType(root, 'Text').flatMap(node =>
    node.children.filter((child): child is string => typeof child === 'string')
  );
}

function nodesOfType(root: Instance, type: string): Instance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** The row actions of one file, download first. */
function rowActions(root: Instance, fileName: string): Instance[] {
  return nodesOfType(root, 'RowIconAction').filter(node =>
    String(node.props.label).includes(fileName)
  );
}

function mountBody(overrides: Partial<ComponentProps<typeof SessionArtifactsBody>> = {}) {
  act(() => {
    renderer = TestRenderer.create(
      createElement(SessionArtifactsBody, {
        state: { kind: 'loaded', groups: [], fileCount: 0, sandboxNotRunning: false },
        onRetry: () => undefined,
        onRefresh: () => undefined,
        refreshing: false,
        onDownload: () => undefined,
        onDelete: () => undefined,
        failureOf: () => null,
        pendingOf: () => null,
        ...overrides,
      })
    );
  });
  if (!renderer) {
    throw new Error('the body did not mount');
  }
  return renderer.root;
}

function loadedState({
  sandboxNotRunning = false,
}: { sandboxNotRunning?: boolean } = {}): SessionArtifactsState {
  return {
    kind: 'loaded',
    groups: groupWorkspaceArtifactsByFolder(ENTRIES, i18n.t('cloudAgent.artifacts.title')),
    fileCount: ENTRIES.length,
    sandboxNotRunning,
  };
}

describe('SessionArtifactsBody states', () => {
  it('names the wait while the list has not answered', () => {
    const root = mountBody({ state: { kind: 'loading' } });

    expect(texts(root)).toContain(i18n.t('cloudAgent.artifacts.loading'));
    // The count is not known yet, so the section keeps its own name.
    expect(nodesOfType(root, 'SectionHeader')[0]?.props.label).toBe(
      i18n.t('cloudAgent.artifacts.title')
    );
  });

  it('offers a retry when the read failed in a way that can settle', () => {
    const onRetry = vi.fn<() => void>();
    const root = mountBody({ state: { kind: 'load-error', retryable: true }, onRetry });

    expect(nodesOfType(root, 'EmptyState')[0]?.props.title).toBe(
      i18n.t('cloudAgent.artifacts.loadError')
    );
    const action = required(nodesOfType(root, 'StateAction')[0], 'the retry action');
    expect(action.props.label).toBe(i18n.t('common.retry'));
    act(() => {
      (action.props.onPress as () => void)();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps the copy as the whole answer when a retry cannot settle it', () => {
    const onRetry = vi.fn<() => void>();
    const root = mountBody({ state: { kind: 'load-error', retryable: false }, onRetry });

    // The same sentence names the failure; only the unusable way out is gone.
    expect(nodesOfType(root, 'EmptyState')[0]?.props.title).toBe(
      i18n.t('cloudAgent.artifacts.loadError')
    );
    expect(nodesOfType(root, 'StateAction')).toHaveLength(0);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('explains where saved files come from when the session has none', () => {
    const root = mountBody({ state: { kind: 'empty', sandboxNotRunning: false } });

    expect(nodesOfType(root, 'EmptyState')[0]?.props.title).toBe(
      i18n.t('cloudAgent.artifacts.empty')
    );
    expect(nodesOfType(root, 'SectionHeader')[0]?.props.label).toBe(
      i18n.t('cloudAgent.artifacts.fileCount', { count: 0 })
    );
  });

  it('paints each folder with its files and their sizes', () => {
    const root = mountBody({ state: loadedState() });
    const painted = texts(root);

    expect(painted).toContain('reports');
    expect(painted).toContain('charts');
    expect(painted).toContain('summary.pdf');
    expect(painted).toContain('q4.png');
    expect(painted).toContain(formatFileSize(1_400_000, i18n.language));
    expect(painted).toContain(formatFileSize(812_000, i18n.language));
    expect(painted).toContain(i18n.t('cloudAgent.artifacts.keptUntil'));
    expect(nodesOfType(root, 'SectionHeader')[0]?.props.label).toBe(
      i18n.t('cloudAgent.artifacts.fileCount', { count: ENTRIES.length })
    );
  });

  it('names the sandbox when it is not running, above the list it kept', () => {
    const paused = mountBody({ state: loadedState({ sandboxNotRunning: true }) });
    expect(texts(paused)).toContain(i18n.t('cloudAgent.artifacts.sandboxNotRunning'));

    act(() => {
      renderer?.unmount();
    });
    const running = mountBody({ state: loadedState({ sandboxNotRunning: false }) });
    expect(texts(running)).not.toContain(i18n.t('cloudAgent.artifacts.sandboxNotRunning'));
  });

  it('does not name a sandbox that has not answered yet', () => {
    const root = mountBody({ state: { kind: 'loading' } });

    expect(texts(root)).not.toContain(i18n.t('cloudAgent.artifacts.sandboxNotRunning'));
  });

  it.each([
    { kind: 'delete-changed', copy: 'deleteChanged' },
    { kind: 'download-failed', copy: 'downloadError' },
    { kind: 'download-share-failed', copy: 'downloadShareFailed' },
  ] as const)('reports a $kind under the file it was for', ({ kind, copy }) => {
    const failure: ArtifactFailure = { kind, fileName: 'summary.pdf' };
    const root = mountBody({
      state: loadedState(),
      failureOf: relativePath => (relativePath === 'reports/summary.pdf' ? failure : null),
    });

    expect(nodesOfType(root, 'AccessibleStatus').map(node => node.props.message)).toContain(
      i18n.t(`cloudAgent.artifacts.${copy}`, { fileName: 'summary.pdf' })
    );
  });

  it('hands the two actions the row they were pressed on', () => {
    const onDownload = vi.fn<(pressed: WorkspaceArtifactEntry) => void>();
    const onDelete = vi.fn<(pressed: WorkspaceArtifactEntry) => void>();
    const root = mountBody({ state: loadedState(), onDownload, onDelete });

    // Folders paint in path order, so the report's row is the one whose label
    // names it rather than whichever row came first.
    const [download, remove] = rowActions(root, 'summary.pdf');
    expect(required(download, 'the download action').props.label).toBe(
      i18n.t('cloudAgent.artifacts.downloadA11y', { fileName: 'summary.pdf' })
    );
    act(() => {
      (required(download, 'the download action').props.onPress as () => void)();
      (required(remove, 'the delete action').props.onPress as () => void)();
    });
    expect(onDownload).toHaveBeenCalledWith(ENTRIES[0]);
    expect(onDelete).toHaveBeenCalledWith(ENTRIES[0]);
  });

  it('keeps a row inert while its own action runs', () => {
    const root = mountBody({
      state: loadedState(),
      pendingOf: relativePath => (relativePath === 'reports/summary.pdf' ? 'delete' : null),
    });
    const actions = nodesOfType(root, 'RowIconAction').filter(node =>
      String(node.props.label).includes('summary.pdf')
    );

    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.props.disabled).toBe(true);
    }
    // The other row keeps both of its actions.
    expect(
      nodesOfType(root, 'RowIconAction')
        .filter(node => String(node.props.label).includes('q4.png'))
        .every(node => node.props.disabled === false)
    ).toBe(true);
  });

  it('refuses the refresh while a read is in flight', () => {
    const onRefresh = vi.fn<() => void>();
    const root = mountBody({ state: loadedState(), refreshing: true, onRefresh });
    const header = required(nodesOfType(root, 'SectionHeader')[0], 'the section header');

    expect(header.props.actionLabel).toBe(i18n.t('common.refresh'));
    expect(header.props.actionDisabled).toBe(true);
    act(() => {
      (header.props.onActionPress as () => void)();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

async function mountSheet(): Promise<Renderer> {
  const view = await renderWithProviders(
    createElement(SessionArtifactsSheet, {
      visible: true,
      onClose: () => undefined,
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      organizationId: undefined,
    })
  );
  renderer = view.renderer;
  return view.renderer;
}

/** Answers the confirmation the sheet raised, then flushes what it settles. */
async function answerConfirm(): Promise<void> {
  const request = holder.confirm;
  if (request === null) {
    throw new Error('the sheet asked for no confirmation');
  }
  await act(async () => {
    request.onConfirm();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SessionArtifactsSheet delete', () => {
  it('deletes the file the confirmation named and drops it from the list', async () => {
    const sheet = await mountSheet();
    await waitFor(() => rowActions(sheet.root, 'summary.pdf').length === 2);

    const remove = required(rowActions(sheet.root, 'summary.pdf')[1], 'the delete action');
    await act(async () => {
      (remove.props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(holder.confirm?.title).toBe(
      i18n.t('cloudAgent.artifacts.deleteConfirmTitle', { fileName: 'summary.pdf' })
    );
    expect(holder.confirm?.message).toBe(i18n.t('cloudAgent.artifacts.deleteConfirmBody'));
    expect(holder.confirm?.confirmLabel).toBe(i18n.t('cloudAgent.artifacts.deleteConfirmAction'));

    holder.entries = [ENTRIES[1]];
    await answerConfirm();

    expect(holder.deleteArtifact).toHaveBeenCalledWith({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      relativePath: 'reports/summary.pdf',
      expectedHash: ENTRIES[0]?.contentHash,
    });
    expect(rowActions(sheet.root, 'summary.pdf')).toHaveLength(0);
    expect(rowActions(sheet.root, 'q4.png')).toHaveLength(2);
  });

  it('keeps a file that changed under the list and says so', async () => {
    const sheet = await mountSheet();
    await waitFor(() => rowActions(sheet.root, 'summary.pdf').length === 2);
    holder.deleteResult = { status: 'hash_mismatch', revision: 3 };

    const remove = required(rowActions(sheet.root, 'summary.pdf')[1], 'the delete action');
    await act(async () => {
      (remove.props.onPress as () => void)();
      await Promise.resolve();
    });
    await answerConfirm();
    await waitFor(() =>
      nodesOfType(sheet.root, 'AccessibleStatus').some(
        node =>
          node.props.message ===
          i18n.t('cloudAgent.artifacts.deleteChanged', { fileName: 'summary.pdf' })
      )
    );

    expect(rowActions(sheet.root, 'summary.pdf')).toHaveLength(2);
    expect(nodesOfType(sheet.root, 'AccessibleStatus').map(node => node.props.message)).toContain(
      i18n.t('cloudAgent.artifacts.deleteChanged', { fileName: 'summary.pdf' })
    );
  });

  it('reports a refused delete through one toast and leaves the row without a line', async () => {
    const sheet = await mountSheet();
    await waitFor(() => rowActions(sheet.root, 'summary.pdf').length === 2);
    holder.deleteError = new Error('Artifacts storage is unavailable');

    const remove = required(rowActions(sheet.root, 'summary.pdf')[1], 'the delete action');
    await act(async () => {
      (remove.props.onPress as () => void)();
      await Promise.resolve();
    });
    await answerConfirm();

    // One surface owns the report: the mutation's toast, and no row line under
    // the file it was for.
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('Artifacts storage is unavailable');
    expect(nodesOfType(sheet.root, 'AccessibleStatus')).toHaveLength(0);
    expect(rowActions(sheet.root, 'summary.pdf')).toHaveLength(2);
  });
});

describe('SessionArtifactsSheet download', () => {
  it('shares the file the link names under the file it belongs to', async () => {
    const sheet = await mountSheet();
    await waitFor(() => rowActions(sheet.root, 'summary.pdf').length === 2);

    const download = required(rowActions(sheet.root, 'summary.pdf')[0], 'the download action');
    await act(async () => {
      (download.props.onPress as () => void)();
      await Promise.resolve();
    });
    await waitFor(() => holder.shareRemoteFile.mock.calls.length > 0);

    expect(holder.mintUrl).toHaveBeenCalledWith({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      relativePath: 'reports/summary.pdf',
    });
    expect(holder.shareRemoteFile).toHaveBeenCalledWith({
      url: 'https://example.com/artifact',
      cacheDirectoryName: 'session-artifacts',
      cacheKey: 'reports/summary.pdf',
      filename: 'summary.pdf',
    });
    // A share that opened leaves no line behind.
    expect(nodesOfType(sheet.root, 'AccessibleStatus')).toHaveLength(0);
  });

  it('reports a link it could not mint under the row', async () => {
    const sheet = await mountSheet();
    await waitFor(() => rowActions(sheet.root, 'summary.pdf').length === 2);
    holder.downloadError = new Error('Could not sign the artifact URL');

    const download = required(rowActions(sheet.root, 'summary.pdf')[0], 'the download action');
    await act(async () => {
      (download.props.onPress as () => void)();
      await Promise.resolve();
    });
    await waitFor(() => nodesOfType(sheet.root, 'AccessibleStatus').length > 0);

    expect(holder.shareRemoteFile).not.toHaveBeenCalled();
    expect(nodesOfType(sheet.root, 'AccessibleStatus').map(node => node.props.message)).toContain(
      i18n.t('cloudAgent.artifacts.downloadError', { fileName: 'summary.pdf' })
    );
  });

  it('reports a share the device could not open under the row', async () => {
    const sheet = await mountSheet();
    await waitFor(() => rowActions(sheet.root, 'summary.pdf').length === 2);
    holder.shareFailureKind = 'retry';
    holder.shareRemoteFile.mockImplementation(async () => {
      throw new Error('download-network');
    });

    const download = required(rowActions(sheet.root, 'summary.pdf')[0], 'the download action');
    await act(async () => {
      (download.props.onPress as () => void)();
      await Promise.resolve();
    });
    await waitFor(() => nodesOfType(sheet.root, 'AccessibleStatus').length > 0);

    expect(nodesOfType(sheet.root, 'AccessibleStatus').map(node => node.props.message)).toContain(
      i18n.t('cloudAgent.artifacts.downloadShareFailed', { fileName: 'summary.pdf' })
    );
  });
});

describe('SessionArtifactsSheet load errors', () => {
  /** A tRPC client failure on the wire: a code, and the HTTP status the read's retry policy reads. */
  function trpcError(code: string, httpStatus: number): Error {
    return Object.assign(new Error(code), { name: 'TRPCClientError', data: { code, httpStatus } });
  }

  it('offers a retry for a failure the server can answer differently next time', async () => {
    holder.listError = trpcError('PRECONDITION_FAILED', 412);
    const sheet = await mountSheet();
    await waitFor(() => nodesOfType(sheet.root, 'StateAction').length > 0);

    expect(nodesOfType(sheet.root, 'EmptyState')[0]?.props.title).toBe(
      i18n.t('cloudAgent.artifacts.loadError')
    );
    const action = required(nodesOfType(sheet.root, 'StateAction')[0], 'the retry action');
    expect(action.props.label).toBe(i18n.t('common.retry'));

    const reads = holder.fetchList.mock.calls.length;
    await act(async () => {
      (action.props.onPress as () => void)();
      await Promise.resolve();
    });
    await waitFor(() => holder.fetchList.mock.calls.length > reads);
  });

  it('keeps the copy alone when retrying cannot change the refusal', async () => {
    holder.listError = trpcError('FORBIDDEN', 403);
    const sheet = await mountSheet();
    await waitFor(() => nodesOfType(sheet.root, 'EmptyState').length > 0);

    // The same sentence names the failure; no way out is offered beside it.
    expect(nodesOfType(sheet.root, 'EmptyState')[0]?.props.title).toBe(
      i18n.t('cloudAgent.artifacts.loadError')
    );
    expect(nodesOfType(sheet.root, 'StateAction')).toHaveLength(0);
  });
});
