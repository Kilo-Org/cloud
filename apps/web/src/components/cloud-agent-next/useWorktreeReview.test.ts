import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { StoredSession } from './types';
import type { PersistedWorktreeReviewDraft, WorktreeReviewScope } from './worktree-review-state';
import type { WorktreeReviewAnchor } from './worktree-review';
import type { WorktreeReviewSendApi, WorktreeReviewSubmission } from './worktree-review-send';
import type { useWorktreeReview as UseWorktreeReview } from './useWorktreeReview';

const mockLoad = jest.fn<(key: string) => Promise<PersistedWorktreeReviewDraft | null>>();
const mockSave = jest.fn();
const mockClear = jest.fn();
const mockPersistence = { load: mockLoad, save: mockSave, clear: mockClear };

jest.mock('./worktree-review-persistence', () => ({
  createWorktreeReviewPersistence: () => mockPersistence,
}));
jest.mock('../../../node_modules/@pierre/diffs/dist/utils/iterateOverDiff.js', () => ({
  iterateOverDiff: () => [],
}));
jest.mock('../../../node_modules/@pierre/diffs/dist/utils/parsePatchFiles.js', () => ({
  parsePatchFiles: () => [],
}));

const snapshot = {
  revision: 3,
  capturedAt: '2026-09-09T09:00:00.000Z',
  comparison: {
    baseRef: 'refs/remotes/origin/main',
    mergeBase: 'a'.repeat(40),
    head: 'b'.repeat(40),
  },
  files: [{ path: 'src/example.ts', revision: 3 }],
  truncated: false,
};
const worktreeId = 'worktree_5b07b5d0-c89d-48b1-96c8-dde3ddcfb282';
const scope: WorktreeReviewScope = {
  userId: 'user-a',
  organizationId: undefined,
  workspaceScope: `worktree:${worktreeId}`,
};
const anchor: WorktreeReviewAnchor = {
  capture: {
    ...scope,
    sourceCloudAgentSessionId: 'workspace_target',
    ...snapshot,
  },
  path: 'src/example.ts',
  range: { side: 'additions', startLine: 4, endLine: 4 },
  quote: {
    source: 'saved-patch',
    lines: [{ lineNumber: 4, kind: 'addition', text: 'const value = 1;\n' }],
  },
};
const targetSession = {
  session_id: 'ses_target',
  organization_id: null,
  cloud_agent_worktree_id: worktreeId,
  cloud_agent_session_id: 'workspace_target',
  created_on_platform: 'cloud-agent-web',
  parent_session_id: null,
};
let mockSessionRows = [targetSession];
const mockTrpc = {
  cliSessionsV2: {
    list: {
      queryOptions: jest.fn(() => ({ queryKey: ['sessions'] })),
    },
  },
  cloudAgentNext: {
    getWorktreeChanges: {
      queryOptions: jest.fn(() => ({ queryFn: async () => ({ snapshot }) })),
    },
    getWorktreeFile: {
      queryOptions: jest.fn(() => ({ queryKey: ['file'] })),
    },
  },
  organizations: {
    cloudAgentNext: {
      getWorktreeChanges: {
        queryOptions: jest.fn(() => ({ queryFn: async () => ({ snapshot }) })),
      },
      getWorktreeFile: {
        queryOptions: jest.fn(() => ({ queryKey: ['file'] })),
      },
    },
  },
};

jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));
jest.mock('@tanstack/react-query', () => ({
  skipToken: Symbol('skipToken'),
  useQueryClient: () => ({
    fetchQuery: async () => ({ status: 'not_captured' }),
  }),
  useQuery: () => ({
    data: { cliSessions: mockSessionRows },
    isError: false,
    refetch: async () => ({ data: { cliSessions: mockSessionRows }, isSuccess: true }),
  }),
  useQueries: ({ queries }: { queries: unknown[] }) =>
    queries.map(() => ({
      data: { snapshot },
      isSuccess: true,
      refetch: async () => ({ data: { snapshot }, isSuccess: true }),
    })),
}));

type LinkedomModule = {
  parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = new Map<string, unknown>();
  for (const name of [
    'React',
    'window',
    'document',
    'HTMLElement',
    'HTMLAnchorElement',
    'Element',
    'Node',
    'Event',
    'IS_REACT_ACT_ENVIRONMENT',
  ]) {
    previous.set(name, globals[name]);
  }
  Object.assign(globals, {
    React,
    window,
    document,
    HTMLElement: (window as { HTMLElement: typeof HTMLElement }).HTMLElement,
    HTMLAnchorElement: (window as { HTMLAnchorElement: typeof HTMLAnchorElement })
      .HTMLAnchorElement,
    Element: (window as { Element: typeof Element }).Element,
    Node: (window as { Node: typeof Node }).Node,
    Event: (window as { Event: typeof Event }).Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');
  return {
    container: container as HTMLElement,
    cleanup: () => previous.forEach((value, key) => (globals[key] = value)),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushAsyncWork() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

let useWorktreeReview!: typeof UseWorktreeReview;
let latest: ReturnType<typeof useWorktreeReview> | undefined;

function Probe({ props }: { props: Parameters<typeof useWorktreeReview>[0] }) {
  latest = useWorktreeReview(props);
  return createElement('div');
}

const api = {} as WorktreeReviewSendApi;
const chats = [
  {
    sessionId: targetSession.session_id,
    repository: 'owner/repo',
    prompt: 'Target chat',
    mode: 'code',
    model: 'model-a',
    status: 'active',
    createdAt: snapshot.capturedAt,
    updatedAt: snapshot.capturedAt,
    messages: [],
    cloudAgentSessionId: targetSession.cloud_agent_session_id,
    createdOnPlatform: targetSession.created_on_platform,
    worktreeId,
  },
] as StoredSession[];

const otherSession = {
  ...targetSession,
  session_id: 'ses_other',
  cloud_agent_session_id: 'workspace_other',
};
const otherChat = {
  ...chats[0],
  sessionId: otherSession.session_id,
  prompt: 'Other chat',
  cloudAgentSessionId: otherSession.cloud_agent_session_id,
} as StoredSession;

const defaultProps: Parameters<typeof useWorktreeReview>[0] = {
  userId: scope.userId,
  organizationId: scope.organizationId,
  worktreeId,
  activeKiloSessionId: targetSession.session_id,
  activeSessionConfig: null,
  enabled: true,
  worktreeChats: chats,
  deletingSessionIds: [],
  api,
  onAccepted: jest.fn(),
};

function mount(overrides: Partial<Parameters<typeof useWorktreeReview>[0]> = {}) {
  const dom = installDom();
  const root = createRoot(dom.container);
  const props = { ...defaultProps, ...overrides };
  act(() => {
    root.render(
      createElement(Probe, {
        props,
      })
    );
  });
  return { dom, root, props };
}

beforeAll(async () => {
  ({ useWorktreeReview } = await import('./useWorktreeReview'));
});

describe('useWorktreeReview hydration', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    mockLoad.mockReset();
    mockSave.mockReset();
    mockClear.mockReset();
    mockSessionRows = [targetSession];
    latest = undefined;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  it('starts hydration for an eligible scope before Review is opened', async () => {
    const loading = deferred<PersistedWorktreeReviewDraft | null>();
    mockLoad.mockReturnValue(loading.promise);
    ({
      dom: { cleanup },
      root,
    } = mount());

    expect(mockLoad).toHaveBeenCalledWith(
      JSON.stringify([scope.userId, undefined, scope.workspaceScope])
    );
    expect(latest?.open).toBe(false);
    expect(latest?.disabledReason).toBe('Restoring saved review…');

    loading.resolve({
      version: 1,
      comments: [{ id: 'restored', anchor, text: 'Restored feedback' }],
      editor: null,
      overall: '',
      destinationKiloSessionId: targetSession.session_id,
      allowOlderCapture: false,
    });
    await flushAsyncWork();

    expect(latest?.draft?.comments.map(comment => comment.text)).toEqual(['Restored feedback']);
    expect(latest?.disabledReason).toBeUndefined();
    act(() => latest?.setEditor({ anchor, text: 'New feedback' }));
    expect(latest?.draft?.editor?.text).toBe('New feedback');
  });

  it.each([
    ['empty database', null],
    ['load rejection', new Error('IndexedDB unavailable')],
  ] as const)('%s settles and leaves authoring enabled', async (_case, result) => {
    if (result instanceof Error) mockLoad.mockRejectedValue(result);
    else mockLoad.mockResolvedValue(null);
    ({
      dom: { cleanup },
      root,
    } = mount());
    await flushAsyncWork();

    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(latest?.open).toBe(false);
    expect(latest?.disabledReason).toBeUndefined();
    act(() => latest?.setEditor({ anchor, text: 'Authoring works' }));
    expect(latest?.draft?.editor?.text).toBe('Authoring works');
  });

  it('shows Review only after a comment is saved', async () => {
    mockLoad.mockResolvedValue(null);
    const mounted = mount();
    ({ cleanup } = mounted.dom);
    root = mounted.root;
    await flushAsyncWork();

    expect(latest?.visible).toBe(false);
    act(() => latest?.setEditor({ anchor, text: 'Saved feedback' }));
    act(() => latest?.saveEditor());
    expect(latest?.draft?.comments).toHaveLength(1);
    expect(latest?.visible).toBe(true);
  });

  it('closes an open Review when its last comment is removed', async () => {
    mockLoad.mockResolvedValue({
      version: 1,
      comments: [{ id: 'saved', anchor, text: 'Saved feedback' }],
      editor: null,
      overall: '',
      destinationKiloSessionId: targetSession.session_id,
      allowOlderCapture: false,
    });
    const mounted = mount();
    ({ cleanup } = mounted.dom);
    root = mounted.root;
    await flushAsyncWork();

    act(() => latest?.setOpen(true));
    expect(latest?.open).toBe(true);

    act(() => {
      latest?.removeComment('saved');
    });

    expect(latest?.open).toBe(false);
    expect(latest?.visible).toBe(false);
  });

  it.each([
    ['missing destination', null, 'ses_target'],
    ['obsolete destination', 'ses_obsolete', 'ses_target'],
  ] as const)('%s is handled when the review dialog opens', async (_case, current, expected) => {
    mockLoad.mockResolvedValue({
      version: 1,
      comments: [{ id: 'saved', anchor, text: 'Saved feedback' }],
      editor: null,
      overall: '',
      destinationKiloSessionId: current,
      allowOlderCapture: false,
    });
    const mounted = mount();
    ({ cleanup } = mounted.dom);
    root = mounted.root;
    await flushAsyncWork();

    act(() => latest?.setOpen(true));
    await flushAsyncWork();

    expect(latest?.draft?.destinationKiloSessionId).toBe(expected);
  });

  it('keeps a valid non-active destination when the review dialog opens', async () => {
    mockSessionRows = [targetSession, otherSession];
    mockLoad.mockResolvedValue({
      version: 1,
      comments: [{ id: 'saved', anchor, text: 'Saved feedback' }],
      editor: null,
      overall: '',
      destinationKiloSessionId: otherSession.session_id,
      allowOlderCapture: false,
    });
    const mounted = mount({ worktreeChats: [...chats, otherChat] });
    ({ cleanup } = mounted.dom);
    root = mounted.root;
    await flushAsyncWork();

    expect(latest?.destinations.map(destination => destination.sessionId)).toEqual([
      targetSession.session_id,
      otherSession.session_id,
    ]);
    act(() => latest?.setOpen(true));
    await flushAsyncWork();

    expect(latest?.draft?.destinationKiloSessionId).toBe(otherSession.session_id);
  });

  it('does not retarget an unknown delivery even when its destination is obsolete', async () => {
    const reviewSubmission = {
      destinationKiloSessionId:
        targetSession.session_id as WorktreeReviewSubmission['destinationKiloSessionId'],
      destinationCloudAgentSessionId: targetSession.cloud_agent_session_id as NonNullable<
        WorktreeReviewSubmission['destinationCloudAgentSessionId']
      >,
      expectedWorktreeId: worktreeId,
      messageId: 'message-review',
      payload: {
        type: 'prompt' as const,
        prompt: 'Review feedback',
        mode: 'code',
        model: 'model-a',
      },
    } satisfies WorktreeReviewSubmission;
    const unknownApi: WorktreeReviewSendApi = {
      prepareReviewSubmission: async () => reviewSubmission,
      submitReview: async () => ({ status: 'unknown', error: 'Delivery is unknown' }),
    };
    mockLoad.mockResolvedValue({
      version: 1,
      comments: [{ id: 'saved', anchor, text: 'Saved feedback' }],
      editor: null,
      overall: '',
      destinationKiloSessionId: targetSession.session_id,
      allowOlderCapture: false,
    });
    const mounted = mount({ api: unknownApi });
    ({ cleanup } = mounted.dom);
    root = mounted.root;
    await flushAsyncWork();
    act(() => latest?.setOpen(true));
    await flushAsyncWork();

    await act(async () => {
      await latest?.send();
    });
    expect(latest?.draft?.delivery.phase).toBe('unknown');

    mockSessionRows = [otherSession];
    act(() => {
      mounted.root.render(
        createElement(Probe, {
          props: { ...defaultProps, api: unknownApi, worktreeChats: [otherChat] },
        })
      );
    });
    await flushAsyncWork();

    expect(latest?.destinations.map(destination => destination.sessionId)).toEqual(['ses_other']);
    expect(latest?.draft?.destinationKiloSessionId).toBe(targetSession.session_id);
  });
});
