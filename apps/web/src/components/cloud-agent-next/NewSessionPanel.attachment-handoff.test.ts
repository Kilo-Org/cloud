import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { NewSessionPanel as NewSessionPanelComponent } from './NewSessionPanel';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mockRouterPush = jest.fn();
const mockQueryClient = {
  setQueryData: jest.fn(),
  invalidateQueries: jest.fn(),
  fetchQuery: jest.fn(async () => ({ status: 'unavailable', repositories: [] })),
};
const mockCreateLocalSession = jest.fn((_draft: unknown) => 'local-session-1');
const mockReleaseMutate = jest.fn(async (_input: unknown) => undefined);
let mockUploadUrlRequest:
  | { messageUuid: string; attachmentId: string; contentLength: number }
  | undefined;

const mockGetUploadUrl = jest.fn(
  async (input: { messageUuid: string; attachmentId: string; contentLength: number }) => {
    mockUploadUrlRequest = input;
    return {
      key: `${input.messageUuid}/handoff.txt`,
      signedUrl: 'https://uploads.test/handoff.txt',
    };
  }
);

function mockCreateTrpc(path: string[] = []): unknown {
  return new Proxy(function () {}, {
    get(_target, property) {
      if (typeof property !== 'string' || property === 'then') return undefined;
      if (property === 'queryOptions') {
        return (input?: unknown) => ({
          __testKind: path.join('.'),
          queryKey: [path.join('.')],
          input,
        });
      }
      if (property === 'mutationOptions') {
        return () => ({ __testKind: path.join('.') });
      }
      if (property === 'queryKey') return () => [path.join('.')];
      return mockCreateTrpc([...path, property]);
    },
  });
}

const mockRepository = {
  id: 'repo-1',
  name: 'repo',
  fullName: 'acme/repo',
  private: false,
  platformIntegrationId: 'integration-1',
};

function mockQueryResult(options: { __testKind?: string }) {
  const kind = options.__testKind ?? '';
  const base = {
    data: undefined as unknown,
    isLoading: false,
    isPending: false,
    isError: false,
    isFetching: false,
    isRefetching: false,
    error: null,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
  if (kind.endsWith('checkEligibility')) {
    return { ...base, data: { isEligible: true, accessLevel: 'full', balance: 0 } };
  }
  if (kind.endsWith('listGitHubRepositories')) {
    return { ...base, data: { repositories: [mockRepository], integrationInstalled: true } };
  }
  if (kind.endsWith('listGitLabRepositories')) {
    return { ...base, data: { repositories: [], integrationInstalled: true } };
  }
  if (kind.endsWith('listBitbucketRepositories')) {
    return { ...base, data: { status: 'unavailable', repositories: [] } };
  }
  if (kind.endsWith('bitbucket.getStatus')) {
    return { ...base, data: { status: 'unavailable' } };
  }
  if (kind.endsWith('recentRepositories')) {
    return { ...base, data: { repositories: [] } };
  }
  return base;
}

function mockMutationResult(options: { __testKind?: string }) {
  const kind = options.__testKind ?? '';
  if (kind.endsWith('releasePendingUploads')) {
    return { mutateAsync: mockReleaseMutate, isPending: false };
  }
  if (kind.endsWith('getAttachmentUploadUrl')) {
    return { mutateAsync: mockGetUploadUrl, isPending: false };
  }
  return { mutateAsync: jest.fn(async () => undefined), isPending: false };
}

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { __testKind?: string }) => mockQueryResult(options),
  useMutation: (options: { __testKind?: string }) => mockMutationResult(options),
  useQueryClient: () => mockQueryClient,
}));

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => mockCreateTrpc(),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

jest.mock('jotai', () => ({
  useAtom: () => [null, jest.fn()],
  useSetAtom: () => jest.fn(),
}));

jest.mock('@/components/cloud-agent/store/session-form-atoms', () => ({
  selectedProfileIdAtom: {},
  resetSessionFormAtom: {},
}));

jest.mock('./local-sessions/LocalSessionsProvider', () => ({
  useLocalSessions: () => ({
    localSessions: [],
    restored: true,
    createLocalSession: (draft: unknown) => mockCreateLocalSession(draft),
    retryLocalSession: () => null,
    discardLocalSession: () => {},
    discardedPrompt: 'Fix the upload handoff',
    clearDiscardedPrompt: () => {},
    settleLocalSessions: () => {},
  }),
}));

jest.mock('./useSandboxPicker', () => ({
  useSandboxPicker: () => ({
    picker: { allocation: undefined },
    groups: [],
    error: null,
    isVisible: false,
    query: { isPending: false, isSuccess: false, isError: false, isFetching: false },
    choose: jest.fn(),
    chooseDefault: jest.fn(),
  }),
}));

jest.mock('@/hooks/useCloudAgentProfiles', () => ({
  useProfiles: () => ({ data: [] }),
  useCombinedProfiles: () => ({ data: undefined }),
  useProfile: () => ({ data: undefined }),
}));

jest.mock('@/hooks/useRefreshRepositories', () => ({
  useRefreshRepositories: () => ({ refresh: jest.fn(), isRefreshing: false }),
}));

jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationDefaults: () => ({ data: undefined }),
}));

jest.mock('@/lib/hooks/use-openrouter-models', () => ({
  useModelSelectorList: () => ({
    data: {
      data: [
        {
          id: 'model-1',
          name: 'Model One',
          isFree: true,
          mayTrainOnYourPrompts: false,
          hasUserByokAvailable: false,
          opencode: { variants: {} },
        },
      ],
    },
  }),
}));

jest.mock('@/lib/hooks/use-model-preferences', () => ({
  useModelPreferences: () => ({ lastSelected: undefined, setLastSelected: jest.fn() }),
}));

jest.mock(
  '@cloud-agent-shared',
  () => ({
    commandsOrDefault: () => [],
  }),
  { virtual: true }
);

jest.mock('@kilocode/cloud-agent-sdk/message-id', () => ({
  generateMessageId: () => 'message-1',
}));

jest.mock('@/components/SetPageTitle', () => ({ SetPageTitle: () => null }));
jest.mock('@/components/shared/ModeCombobox', () => ({
  ModeCombobox: () => null,
  NEXT_MODE_OPTIONS: [],
}));
jest.mock('@/components/shared/ModelCombobox', () => ({ ModelCombobox: () => null }));
jest.mock('@/components/shared/VariantCombobox', () => ({ VariantCombobox: () => null }));
jest.mock('@/components/shared/InsufficientBalanceBanner', () => ({
  InsufficientBalanceBanner: () => null,
}));
jest.mock('@/components/cloud-agent/ProfilePickerPopover', () => ({
  ProfilePickerPopover: () => null,
}));
jest.mock('./BrowseCommandsDialog', () => ({ BrowseCommandsDialog: () => null }));
jest.mock('./MobileToolbarPopover', () => ({ MobileToolbarPopover: () => null }));
jest.mock('./MobileSidebarToggle', () => ({ MobileSidebarToggle: () => null }));
jest.mock('./AttachmentPreviewStrip', () => ({ AttachmentPreviewStrip: () => null }));
jest.mock('./NewSessionSandboxSelect', () => ({ NewSessionSandboxSelect: () => null }));
jest.mock('./RepositoryProviderOnboardingPanel', () => ({
  RepositoryProviderOnboardingPanel: () => null,
}));

type LinkedomParseHtml = (html: string) => {
  document: Document;
  window: typeof globalThis & {
    Event: typeof Event;
    HTMLElement: typeof HTMLElement;
  };
};

function installLinkedomDom(): { cleanup: () => void; container: HTMLElement } {
  const requireFromHere = createRequire(__filename);
  const loadLinkedom = (): { parseHTML: LinkedomParseHtml } => {
    try {
      return requireFromHere('linkedom') as { parseHTML: LinkedomParseHtml };
    } catch {
      return requireFromHere(
        '../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
      ) as { parseHTML: LinkedomParseHtml };
    }
  };
  const { parseHTML } = loadLinkedom();
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const container = document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');

  return {
    container: container as unknown as HTMLElement,
    cleanup: () => {
      Object.assign(globalThis, previous);
    },
  };
}

type Fiber = {
  type: unknown;
  memoizedProps?: Record<string, unknown>;
  child?: Fiber | null;
  sibling?: Fiber | null;
};

function walkFiber(fiber: Fiber | null | undefined, visit: (fiber: Fiber) => void) {
  if (!fiber) return;
  visit(fiber);
  walkFiber(fiber.child, visit);
  walkFiber(fiber.sibling, visit);
}

function rootFiber(container: HTMLElement): Fiber | undefined {
  const reactKey = Object.keys(container).find(key => key.startsWith('__reactContainer'));
  if (!reactKey) return undefined;
  const host = (container as unknown as Record<string, { stateNode?: { current?: Fiber } }>)[
    reactKey
  ];
  return host?.stateNode?.current;
}

function changeFileInput(container: HTMLElement, files: File[]) {
  let onChange: ((event: { target: { files: File[]; value: string } }) => void) | undefined;
  walkFiber(rootFiber(container), fiber => {
    if (
      fiber.type === 'input' &&
      fiber.memoizedProps?.type === 'file' &&
      typeof fiber.memoizedProps.onChange === 'function'
    ) {
      onChange = fiber.memoizedProps.onChange as typeof onChange;
    }
  });
  if (!onChange) throw new Error('file input onChange not found on fiber tree');
  onChange({ target: { files, value: '' } });
}

async function waitForStartButton(container: HTMLElement): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Start session"]');
    if (button && !button.hasAttribute('disabled')) return button;
  }
  throw new Error('Start session button did not become enabled');
}

class MockXMLHttpRequest {
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  status = 200;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open() {}
  setRequestHeader() {}
  send() {
    queueMicrotask(() => this.onload?.());
  }
  abort() {
    this.onabort?.();
  }
}

type HandoffDraft = {
  request: {
    kind: string;
    input: {
      organizationId?: string;
      attachments?: { path: string; files: string[] };
    };
  };
  firstMessage: { attachmentNames: string[] };
};

let NewSessionPanel: typeof NewSessionPanelComponent;

beforeAll(async () => {
  ({ NewSessionPanel } = await import('./NewSessionPanel'));
});

const scenarios = [
  {
    label: 'personal',
    organizationId: undefined,
    requestKind: 'new-session',
    basePath: '/cloud',
  },
  {
    label: 'organization',
    organizationId: 'org-123',
    requestKind: 'new-organization-session',
    basePath: '/organizations/org-123/cloud',
  },
] as const;

describe.each(scenarios)('$label NewSessionPanel attachment handoff', scenario => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUploadUrlRequest = undefined;
    Object.assign(globalThis, { XMLHttpRequest: MockXMLHttpRequest });
  });

  it('hands a completed attachment to createLocalSession without releasing it', async () => {
    const dom = installLinkedomDom();
    const root = createRoot(dom.container);
    let mounted = true;

    try {
      act(() => {
        root.render(
          createElement(
            NewSessionPanel,
            scenario.organizationId ? { organizationId: scenario.organizationId } : {}
          )
        );
      });
      await waitForStartButton(dom.container);

      act(() => {
        changeFileInput(dom.container, [
          new File(['handoff'], 'handoff.txt', { type: 'text/plain' }),
        ]);
      });

      const startButton = await waitForStartButton(dom.container);
      expect(mockUploadUrlRequest).toBeDefined();

      act(() => startButton.click());

      expect(mockCreateLocalSession).toHaveBeenCalledTimes(1);
      const draft = mockCreateLocalSession.mock.calls[0]?.[0] as unknown as HandoffDraft;
      expect(draft.request.kind).toBe(scenario.requestKind);
      expect(draft.request.input.attachments).toEqual({
        path: mockUploadUrlRequest?.messageUuid,
        files: ['handoff.txt'],
      });
      expect(draft.firstMessage.attachmentNames).toEqual(['handoff.txt']);
      expect(draft.request.input.organizationId).toBe(scenario.organizationId);
      expect(mockRouterPush).toHaveBeenCalledWith(
        `${scenario.basePath}/chat?sessionId=local-session-1`
      );

      expect(mockReleaseMutate).not.toHaveBeenCalled();

      act(() => root.unmount());
      mounted = false;
      expect(mockReleaseMutate).not.toHaveBeenCalled();
    } finally {
      if (mounted) act(() => root.unmount());
      dom.cleanup();
      delete (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
    }
  });
});
