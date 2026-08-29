/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the actual screen and both creators without a DOM */
/* eslint-disable require-await, @typescript-eslint/require-await -- native storage and transport doubles return promises */
/* eslint-disable max-lines -- the screen dependencies and overlapping launch regressions share one mounted harness */
import { type ComponentProps, createElement, useState } from 'react';
import { type CodeReviewPlatform } from '@kilocode/app-shared/code-review';
import { type LaunchRepositoryReference } from '@kilocode/app-shared/code-review/repository-identity';
import { normalizeSessionRepository } from './new-session-repository-state';
import { type ProviderPrepareInput } from './provider-launch-input';
import { NewSessionRepositorySection } from './new-session-repository-section';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { Button } from '@/components/ui/button';
import { listOutboxRows } from '@/lib/persist/mutation-outbox';
import { NewSessionConfigureForm } from './new-session-configure-form';
import { NewSessionScreenBody } from './new-session-screen-body';

type FormProps = ComponentProps<typeof NewSessionConfigureForm>;
type RemoveEvent = { data: { action: { type: string } } };
const native = vi.hoisted(() => ({
  userId: 'user-1',
  organizationId: 'org-1' as string | undefined,
  selectedRepo: '',
  platform: 'github' as CodeReviewPlatform,
  integrationId: 'integration-1',
  repositoryId: '42',
  gitlabInstanceUrl: 'https://git.example.com/base',
  cloneFromKiloSessionId: 'ses_source',
  choose: undefined as ((index?: number) => void) | undefined,
  branchOptions: [] as string[],
  branches: ['develop', 'feature/b4', 'feature/next'],
  defaultBranch: 'develop' as string | null,
  organizations: [] as { organizationId: string; organizationName: string }[],
  organizationDestination: '',
  path: '/continue',
  nextKey: 0,
  errors: [] as string[],
  draft: null as string | null,
  branchError: null as Error | null,
  alert: null as {
    title: string;
    message: string;
    buttons: { text: string; onPress: () => void }[];
  } | null,
  leaveLocked: false,
  beforeRemove: undefined as ((event: RemoveEvent) => void) | undefined,
  rows: new Map<string, { scope: string; k: string; v: string }>(),
}));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Alert: {
    alert: (title: string, message: string, buttons: { text: string; onPress: () => void }[]) => {
      native.alert = { title, message, buttons };
    },
  },
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'icon',
  ExternalLink: 'icon',
  RefreshCw: 'icon',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/route-registry', () => ({
  UNFENCED_ROUTE_KEY: '',
  repoPickerSlot: { set: vi.fn() },
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('./new-session-configure-form', () => ({
  NewSessionConfigureForm: (props: FormProps) =>
    createElement(
      'configure-form',
      props,
      createElement(NewSessionRepositorySection, {
        disabled: props.isCreating,
        isRetrying: props.isRetrying,
        onChange: props.onChangeRepo,
        onConnect: props.onConnectProvider,
        onRefreshRepos: props.onRefreshRepos,
        repositories: props.repositories,
        recents: props.recents,
        groups: props.groups,
        value: props.selectedRepo,
      })
    ),
}));
vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: vi.fn(),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({
    showActionSheetWithOptions: (
      options: { options: string[] },
      choose: (index?: number) => void
    ) => {
      native.branchOptions = options.options;
      native.choose = choose;
    },
  }),
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({
    organizationId: native.organizationId,
    cloneFromKiloSessionId: native.cloneFromKiloSessionId,
  }),
  useRouter: () => ({
    replace: (path: string) => {
      native.path = path;
    },
    setParams: ({ organizationId }: { organizationId: string }) => {
      native.organizationDestination = organizationId;
    },
  }),
  useNavigation: () => ({
    dispatch: () => {
      native.path = '/source';
    },
  }),
}));
vi.mock('@/lib/navigation/prevent-remove', () => ({
  usePreventRemove: (enabled: boolean, onRemove: (event: RemoveEvent) => void) => {
    native.leaveLocked = enabled;
    native.beforeRemove = onRemove;
  },
}));
vi.mock('@/app/(app)/agent-chat/use-new-session-discard-guard', () => ({
  useNewSessionDiscardGuard: vi.fn(),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: native.userId, isLoading: false }),
}));
vi.mock('@tanstack/react-query', () => ({
  skipToken: Symbol('skipToken'),
  useQueryClient: () => ({}),
  useQuery: (options: { queryKey?: readonly [readonly string[], ...unknown[]] }) => ({
    data: options.queryKey?.[0][0] === 'organizations' ? native.organizations : { instances: [] },
    isLoading: false,
    refetch: vi.fn(),
  }),
  useInfiniteQuery: () => ({
    data: {
      pages: [
        {
          branches: native.branches.map(name => ({
            name,
            isDefault: name === native.defaultBranch,
          })),
          defaultBranch: native.defaultBranch,
          nextCursor: null,
        },
      ],
    },
    isPending: false,
    isError: native.branchError !== null,
    isFetching: false,
    // The missing-default fixture still has another branch page.
    hasNextPage: native.defaultBranch === null,
    error: native.branchError,
  }),
}));
vi.mock('@/components/agents/new-session-model-provider', () => ({
  useNewSessionModelState: () => ({
    mode: 'code',
    model: 'model',
    variant: '',
    setMode: vi.fn(),
    setModel: vi.fn(),
    setVariant: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: [], isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-instance-model-catalog', () => ({
  useInstanceModelCatalog: () => ({ catalog: null, isLoading: false }),
}));
vi.mock('@/lib/hooks/use-session-model-options', () => ({
  buildSessionModelOptions: () => ({ options: [] }),
  createRemoteModelOverride: vi.fn(),
}));
vi.mock('@/lib/hooks/use-model-preferences', () => ({
  useModelPreferences: () => ({ setLastSelected: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-persisted-agent-model', () => ({
  usePersistedAgentModel: () => ({ saveModel: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-launch-folder', () => ({ useLaunchFolder: () => ['', vi.fn()] }));
vi.mock('@/components/agents/use-effective-profile-custom-modes', () => ({
  useEffectiveProfileCustomModes: () => ({ customOptions: [], profileAgents: [] }),
}));
vi.mock('@/components/agents/use-effective-agent-profile', () => ({
  useEffectiveAgentProfile: () => ({
    profile: null,
    profileId: null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/agents/use-new-session-prefill', () => ({
  useNewSessionPrefillTargets: () => {
    const [selectedRepo, setSelectedRepo] = useState(native.selectedRepo);
    return { selectedRepo, setSelectedRepo };
  },
}));
vi.mock('@/lib/use-new-session-repos', () => ({
  useNewSessionRepos: () => ({
    repositories: [currentRepository()],
    recents: [],
    groups: native.organizationId ? [{ key: 'bitbucket', status: 'repos', repositories: [] }] : [],
    reposSettled: true,
    isRetrying: false,
    openIntegration: vi.fn(),
    refreshReposForceFresh: vi.fn(),
  }),
}));
vi.mock('@/lib/use-new-session-share-remote', () => ({
  useNewSessionShareRemote: () => ({
    remoteSpawn: { isSpawningRemote: false, onStart: vi.fn() },
    handleRunOnInstanceChange: vi.fn(),
  }),
}));
vi.mock('@/lib/persist/drafts', () => ({
  NEW_SESSION_DRAFT_KEY: 'new-session',
  clearDraft: async () => {
    native.draft = null;
    return true;
  },
  saveDraft: (_userId: string, _key: string, value: string) => {
    native.draft = value;
  },
  resolvePrefillOverDraft: (prefill: string | null, draft: string | null) => prefill ?? draft,
}));
vi.mock('@/lib/persist/use-draft-flush', () => ({ useDraftFlushOnBackground: vi.fn() }));
vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ settled: true, value: native.draft }),
  useRemoteSpawnDraftCleanup: () => ({ markRemoteSpawnAttempted: vi.fn() }),
}));
vi.mock('@/lib/share-payload', () => ({ peekSharePayload: vi.fn() }));
vi.mock('@/components/agents/attachment-picker', () => ({ pickAgentAttachments: vi.fn() }));
vi.mock('@/lib/agent-attachments/use-android-pending-picker-recovery', () => ({
  useAndroidPendingPickerRecovery: vi.fn(),
}));
vi.mock('@/lib/agent-attachments/use-agent-attachment-upload', () => ({
  useAgentAttachmentUpload: () => ({
    attachments: [],
    isUploading: false,
    hasFailedAttachments: false,
    addCandidates: vi.fn(),
    removeAttachment: vi.fn(),
    retryAttachment: vi.fn(),
    reset: vi.fn(),
    uploadPending: async () => ({ ok: true }),
  }),
}));
vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    native.nextKey += 1;
    return `operation-${native.nextKey}`;
  },
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: async () => undefined,
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('sonner-native', () => ({
  toast: {
    error: (message: string) => {
      native.errors.push(message);
    },
  },
}));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/agent-session-cache', () => ({
  invalidateAgentSessionQueries: async () => undefined,
}));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  SESSION_CREATED_EVENT: 'session_created',
}));
vi.mock('@kilocode/cloud-agent-sdk/message-id', () => ({ generateMessageId: () => 'msg_test' }));
// Keep both creators, their retry classifier, and the persisted outbox real.
vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: async (scope: string, k: string) => native.rows.get(`${scope}\0${k}`)?.v ?? null,
  setItem: async (scope: string, k: string, v: string) => {
    native.rows.set(`${scope}\0${k}`, { scope, k, v });
  },
  removeItem: async (scope: string, k: string) => {
    native.rows.delete(`${scope}\0${k}`);
  },
  listEntries: async (scope: string) =>
    [...native.rows.values()].filter(row => row.scope === scope),
}));
vi.mock('@kilocode/cloud-agent-sdk', () => ({ createSessionManager: vi.fn() }));
vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest: vi.fn() }));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
  CLOUD_AGENT_WS_URL: 'wss://ws.test',
  WEB_BASE_URL: 'https://web.test',
}));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: vi.fn(),
}));
vi.mock('@/components/agents/mobile-session-transport-payload', () => ({
  normalizeTransportPayload: vi.fn(),
}));
vi.mock('@/components/agents/mobile-session-diagnostics', () => ({
  formatSafeCloudAgentFailureDiagnostic: vi.fn(),
  withCloudAgentDiagnostics: vi.fn(),
}));
vi.mock('@/components/agents/mobile-session-page-adapter', () => ({
  fetchMobileSessionSnapshotPage: vi.fn(),
}));
vi.mock('@/components/agents/tool-card-image-cache', () => ({ cacheToolAttachment: vi.fn() }));
vi.mock('@/components/agents/file-part-cache', () => ({ cacheFilePart: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activeSessions: { listInstances: { queryOptions: () => ({}) } },
    cloudAgentNext: {
      listRepositoryBranches: {
        infiniteQueryOptions: (input: unknown) => ({
          queryKey: [['personal-branches'], { input, type: 'infinite' }],
        }),
      },
    },
    organizations: {
      list: { queryOptions: () => ({ queryKey: [['organizations', 'list']] }) },
      cloudAgentNext: {
        listRepositoryBranches: {
          infiniteQueryOptions: (input: unknown) => ({
            queryKey: [['org-branches'], { input, type: 'infinite' }],
          }),
        },
      },
    },
  }),
  trpcClient: {
    cloudAgentNext: { prepareSession: { mutate: prepare } },
    organizations: { cloudAgentNext: { prepareSession: { mutate: prepare } } },
  },
}));

function currentRepository() {
  const identity = {
    instanceUrl:
      native.platform === 'gitlab'
        ? native.gitlabInstanceUrl
        : `https://${native.platform === 'github' ? 'github.com' : 'bitbucket.org'}`,
    repositoryId: native.repositoryId,
    fullName: native.platform === 'gitlab' ? 'owner/nested/repo' : 'owner/repo',
    defaultBranch: 'develop',
  };
  const reference: LaunchRepositoryReference = {
    repository:
      native.platform === 'bitbucket'
        ? {
            ...identity,
            provider: 'bitbucket',
            repositoryId: 'repo-uuid',
            workspaceUuid: 'workspace-uuid',
          }
        : { ...identity, provider: native.platform },
    authorization: {
      kind: 'ownerIntegration',
      owner: native.organizationId
        ? { type: 'org', id: native.organizationId }
        : { type: 'user', id: native.userId },
      integrationId: native.integrationId,
    },
  };
  const row = normalizeSessionRepository(
    { private: true, repositoryReference: reference },
    native.userId,
    native.organizationId
  );
  if (!row) {
    throw new Error('Invalid repository fixture');
  }
  return row;
}

type Payload = ProviderPrepareInput & {
  operationKey: string;
  organizationId?: string;
  prompt?: string;
};
const requests: {
  input: Payload;
  response: ReturnType<typeof Promise.withResolvers<{ kiloSessionId: string }>>;
}[] = [];
const acceptedSessions = new Map<string, string>();
async function prepare(input: Payload) {
  const response = Promise.withResolvers<{ kiloSessionId: string }>();
  requests.push({ input, response });
  if (!acceptedSessions.has(input.operationKey)) {
    acceptedSessions.set(input.operationKey, `session-${acceptedSessions.size + 1}`);
  }
  return response.promise;
}
async function storedKeys() {
  const rows = await listOutboxRows('user-1');
  return rows?.map(row => row.operationKey);
}
let screen: TestRenderer.ReactTestRenderer | undefined = undefined;
function form(): FormProps {
  if (!screen) {
    throw new Error('Screen did not mount');
  }
  return screen.root.findByType(NewSessionConfigureForm).props as FormProps;
}
async function mount() {
  await act(async () => {
    screen = TestRenderer.create(createElement(NewSessionScreenBody));
  });
}
async function start() {
  expect(form().isStartDisabled).toBe(false);
  await act(async () => {
    form().onStartSession();
  });
}
function goBack() {
  if (native.leaveLocked) {
    native.beforeRemove?.({ data: { action: { type: 'GO_BACK' } } });
  } else {
    native.path = '/source';
  }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  native.userId = 'user-1';
  native.organizationId = 'org-1';
  native.platform = 'github';
  native.integrationId = 'integration-1';
  native.repositoryId = '42';
  native.gitlabInstanceUrl = 'https://git.example.com/base';
  native.branches = ['develop', 'feature/b4', 'feature/next'];
  native.defaultBranch = 'develop';
  native.organizations = [];
  native.organizationDestination = '';
  native.cloneFromKiloSessionId = 'ses_source';
  native.selectedRepo = currentRepository().key;
  native.path = '/continue';
  native.nextKey = 0;
  native.errors = [];
  native.draft = null;
  native.branchError = null;
  native.alert = null;
  native.leaveLocked = false;
  native.beforeRemove = undefined;
  native.rows.clear();
  requests.length = 0;
  acceptedSessions.clear();
});
afterEach(async () => {
  await act(async () => {
    screen?.unmount();
  });
  screen = undefined;
  vi.unstubAllGlobals();
});

it.each(['success', 'retryable', 'terminal'] as const)(
  'keeps the replacement Continue locked after the old owner returns %s',
  async outcome => {
    await mount();
    await start();
    const first = requests[0];
    if (!first) {
      throw new Error('First launch was not admitted');
    }
    expect(form().isCreating).toBe(true);
    expect(form().isStartDisabled).toBe(true);
    expect(native.leaveLocked).toBe(true);

    native.organizationId = 'org-2';
    await act(async () => {
      screen?.update(createElement(NewSessionScreenBody));
    });
    expect(form().isCreating).toBe(false);
    expect(form().isStartDisabled).toBe(true);
    await act(async () => {
      form().onChangeRepo(currentRepository().key);
    });
    await start();
    const second = requests[1];
    if (!second) {
      throw new Error('Replacement launch was not admitted');
    }
    expect(first.input.organizationId).toBe('org-1');
    expect(second.input.organizationId).toBe('org-2');
    expect(second.input.operationKey).not.toBe(first.input.operationKey);
    expect(form().isCreating).toBe(true);

    await act(async () => {
      if (outcome === 'success') {
        first.response.resolve({ kiloSessionId: 'session-old' });
      } else {
        first.response.reject(
          outcome === 'retryable'
            ? new Error('Lost response')
            : Object.assign(new Error('Denied'), { data: { code: 'BAD_REQUEST' } })
        );
      }
    });
    expect(form().isCreating).toBe(true);
    expect(form().isStartDisabled).toBe(true);
    expect(native.leaveLocked).toBe(true);
    goBack();
    expect(native.path).toBe('/continue');
    expect(native.errors).toEqual([]);
    expect(new Set(await storedKeys())).toEqual(
      new Set([first.input.operationKey, second.input.operationKey])
    );

    await act(async () => {
      second.response.resolve({ kiloSessionId: 'session-current' });
    });
    expect(form().isCreating).toBe(false);
    expect(native.leaveLocked).toBe(false);
    expect(native.path).toContain('agent-chat/session-current');
    expect(await storedKeys()).toEqual([first.input.operationKey]);
  }
);

it.each(['retryable', 'terminal'] as const)(
  'releases a current %s failure for a safe retry',
  async outcome => {
    await mount();
    await start();
    const first = requests[0];
    if (!first) {
      throw new Error('Launch was not admitted');
    }
    await act(async () => {
      first.response.reject(
        outcome === 'retryable'
          ? new Error('Lost response')
          : Object.assign(new Error('Denied'), { data: { code: 'BAD_REQUEST' } })
      );
    });
    expect(form().isCreating).toBe(false);
    expect(native.leaveLocked).toBe(false);
    expect(native.path).toBe('/continue');
    expect(native.errors).toEqual([
      outcome === 'retryable' ? 'agentChat.session.cloneFailedRetry' : 'Denied',
    ]);
    expect(await storedKeys()).toEqual(outcome === 'retryable' ? [first.input.operationKey] : []);
    await start();
    const retry = requests[1];
    if (!retry) {
      throw new Error('Retry was not admitted');
    }
    if (outcome === 'retryable') {
      expect(retry.input.operationKey).toBe(first.input.operationKey);
    } else {
      expect(retry.input.operationKey).not.toBe(first.input.operationKey);
    }
    await act(async () => {
      retry.response.resolve({ kiloSessionId: 'session-retry' });
    });
    expect(native.path).toContain('agent-chat/session-retry');
    expect(await listOutboxRows('user-1')).toEqual([]);
  }
);

it('keeps Continue disabled when the selected repository is absent', async () => {
  native.selectedRepo = '';
  await mount();
  expect(form().isStartDisabled).toBe(true);
  expect(form().isCreating).toBe(false);
  expect(native.leaveLocked).toBe(false);
  expect(native.errors).toEqual([]);
  expect(requests).toEqual([]);
});

async function chooseBranch(branch: string) {
  const button = screen?.root
    .findAllByType(Button)
    .map(node => node.props as { accessibilityLabel?: string; onPress: () => void })
    .find(props => props.accessibilityLabel === 'agentChat.newSession.branch');
  if (!button) {
    throw new Error('Branch selector is absent');
  }
  await act(() => {
    button.onPress();
  });
  expect(native.branchOptions).toContain(branch);
  await act(() => {
    native.choose?.(native.branchOptions.indexOf(branch));
  });
}

const launchCases: {
  platform: CodeReviewPlatform;
  organizationId?: string;
  expected: ProviderPrepareInput;
}[] = [
  {
    platform: 'github',
    expected: { githubRepo: 'owner/repo', githubIntegrationId: 'integration-1' },
  },
  {
    platform: 'github',
    organizationId: 'org-1',
    expected: { githubRepo: 'owner/repo', githubIntegrationId: 'integration-1' },
  },
  {
    platform: 'gitlab',
    expected: {
      gitlabProject: 'owner/nested/repo',
      gitlabIntegrationId: 'integration-1',
      gitlabInstanceUrl: 'https://git.example.com/base',
    },
  },
  {
    platform: 'gitlab',
    organizationId: 'org-1',
    expected: {
      gitlabProject: 'owner/nested/repo',
      gitlabIntegrationId: 'integration-1',
      gitlabInstanceUrl: 'https://git.example.com/base',
    },
  },
  {
    platform: 'bitbucket',
    organizationId: 'org-1',
    expected: {
      bitbucketRepo: {
        fullName: 'owner/repo',
        workspaceUuid: 'workspace-uuid',
        repositoryUuid: 'repo-uuid',
      },
      bitbucketIntegrationId: 'integration-1',
    },
  },
];
it.each(['owner', 'repository', 'integration', 'instance'])(
  'resets the branch after a changed %s without deleting the prompt',
  async change => {
    native.platform = 'gitlab';
    native.cloneFromKiloSessionId = '';
    native.selectedRepo = currentRepository().key;
    await mount();
    await act(() => {
      form().onChangeText('Preserve this prompt');
    });
    await chooseBranch('feature/b4');
    if (change === 'owner') {
      native.organizationId = 'org-2';
    }
    if (change === 'repository') {
      native.repositoryId = '84';
    }
    if (change === 'integration') {
      native.integrationId = 'integration-2';
    }
    if (change === 'instance') {
      native.gitlabInstanceUrl = 'https://git.example.com/other';
    }
    await act(() => {
      screen?.update(createElement(NewSessionScreenBody));
    });
    expect(form().isStartDisabled).toBe(true);
    await act(() => {
      form().onStartSession();
    });
    expect(requests).toEqual([]);
    await act(() => {
      form().onChangeRepo(currentRepository().key);
    });
    await start();
    expect(requests[0]?.input).toMatchObject({
      prompt: 'Preserve this prompt',
      upstreamBranch: 'develop',
      gitlabIntegrationId: native.integrationId,
      gitlabInstanceUrl: native.gitlabInstanceUrl,
    });
    await act(() => {
      requests[0]?.response.resolve({ kiloSessionId: 'session-reselected' });
    });
  }
);

it.each([null, 'develop'])(
  'requires branch recovery without losing the prompt when the initial default is %s',
  async defaultBranch => {
    native.cloneFromKiloSessionId = '';
    native.branches = ['develop', 'main', 'feature/b4'];
    native.defaultBranch = defaultBranch;
    await mount();
    await act(() => {
      form().onChangeText('Preserve the branch prompt');
    });
    if (defaultBranch === null) {
      expect(form().isStartDisabled).toBe(true);
      expect(JSON.stringify(screen?.toJSON())).toContain('defaultBranchUnavailable');
      await chooseBranch('feature/b4');
    }
    expect(form().isStartDisabled).toBe(false);
    native.branches = ['main'];
    native.defaultBranch = 'main';
    await act(() => {
      screen?.update(createElement(NewSessionScreenBody));
    });
    expect(form().isStartDisabled).toBe(true);
    expect(JSON.stringify(screen?.toJSON())).toContain('branchUnavailable');
    expect(requests).toEqual([]);
    await chooseBranch('main');
    await start();
    expect(requests[0]?.input).toMatchObject({
      upstreamBranch: 'main',
      prompt: 'Preserve the branch prompt',
    });
    await act(() => {
      requests[0]?.response.resolve({ kiloSessionId: 'session-branch-recovery' });
    });
  }
);

it('offers Personal Bitbucket organization switching and rejects a previous account choice', async () => {
  native.organizationId = undefined;
  native.platform = 'gitlab';
  native.selectedRepo = currentRepository().key;
  await mount();
  expect(JSON.stringify(screen?.toJSON())).toContain('agentChat.newSession.personalBitbucket');
  expect(JSON.stringify(screen?.toJSON())).not.toContain(
    'providerReview.connection.switchOrganization'
  );
  native.organizations = [{ organizationId: 'org-2', organizationName: 'Team Two' }];
  await act(() => {
    screen?.update(createElement(NewSessionScreenBody));
  });
  async function openOrganizationChooser() {
    const button = screen?.root
      .findAllByType(Button)
      .find(
        node =>
          node.findAll(child =>
            child.children.includes('providerReview.connection.switchOrganization')
          ).length > 0
      );
    if (!button) {
      throw new Error('Organization chooser is absent');
    }
    await act(() => {
      (button.props as { onPress: () => void }).onPress();
    });
  }
  await openOrganizationChooser();
  const previous = native.choose;
  native.userId = 'user-2';
  await act(() => {
    screen?.update(createElement(NewSessionScreenBody));
  });
  await act(() => {
    previous?.(0);
  });
  expect(native.organizationDestination).toBe('');
  await openOrganizationChooser();
  await act(() => {
    native.choose?.(0);
  });
  expect(native.organizationDestination).toBe('org-2');
});

it.each(
  (['ordinary', 'continue'] as const).flatMap(entry =>
    launchCases.map(({ platform, organizationId, expected }) => ({
      platform,
      organizationId,
      expected,
      entry,
      owner: organizationId ?? 'Personal',
    }))
  )
)(
  '$entry sends the exact $platform identity for $owner and changes the branch intent',
  async ({ entry, platform, organizationId, expected }) => {
    native.platform = platform;
    native.organizationId = organizationId;
    native.cloneFromKiloSessionId = entry === 'continue' ? 'ses_source' : '';
    native.selectedRepo = currentRepository().key;
    await mount();
    if (entry === 'ordinary') {
      await act(async () => {
        form().onChangeText('Keep this prompt unchanged');
      });
    }
    await chooseBranch('feature/b4');
    await start();
    const first = requests[0];
    if (!first) {
      throw new Error('The selected launch was not admitted');
    }
    expect(first.input).toMatchObject({ ...expected, upstreamBranch: 'feature/b4' });
    expect(first.input.organizationId).toBe(organizationId);
    if (platform !== 'github') {
      expect(first.input).not.toHaveProperty('githubRepo');
    }
    if (entry === 'ordinary') {
      expect(first.input.prompt).toBe('Keep this prompt unchanged');
    } else {
      expect(first.input).not.toHaveProperty('prompt');
    }
    const pendingRows = await listOutboxRows('user-1');
    const firstFingerprint = pendingRows?.[0]?.fingerprint;
    expect(firstFingerprint).toContain('feature/b4');
    expect(firstFingerprint).toContain('integration-1');
    await act(() => {
      native.choose?.(native.branchOptions.indexOf('feature/next'));
    });
    expect(form().isCreating).toBe(true);
    expect(JSON.stringify(screen?.toJSON())).toContain('"text":"feature/b4"');
    await act(async () => {
      first.response.reject(new Error('Lost response'));
    });
    await chooseBranch('feature/next');
    await start();
    const second = requests[1];
    if (!second) {
      throw new Error('The changed branch was not admitted');
    }
    expect(second.input).toMatchObject({ ...expected, upstreamBranch: 'feature/next' });
    expect(second.input.operationKey).not.toBe(first.input.operationKey);
    if (entry === 'ordinary') {
      expect(second.input.prompt).toBe('Keep this prompt unchanged');
    }
    const stored = await listOutboxRows('user-1');
    const secondFingerprint = stored?.find(
      row => row.operationKey === second.input.operationKey
    )?.fingerprint;
    expect(secondFingerprint).toContain('feature/next');
    expect(secondFingerprint).not.toBe(firstFingerprint);
    expect(stored).toHaveLength(2);
    await act(async () => {
      second.response.resolve({ kiloSessionId: 'session-branch' });
    });
    expect(native.path).toContain('agent-chat/session-branch');
  }
);

function seedLegacyRecord(
  entry: 'bare' | 'ordinary' | 'continue',
  invalid = false,
  platform: CodeReviewPlatform = 'github'
) {
  native.platform = platform;
  native.selectedRepo = currentRepository().key;
  native.cloneFromKiloSessionId = entry === 'continue' ? 'ses_source' : '';
  native.path = entry === 'continue' ? '/continue' : '/new';
  native.draft = 'Saved prompt';
  // These are deployed fingerprint bytes, not fingerprints from the new mapper.
  const repo = {
    github: '{"platform":"github","fullName":"owner/repo"}',
    gitlab: '{"platform":"gitlab","fullName":"owner/nested/repo"}',
    bitbucket:
      '{"platform":"bitbucket","fullName":"owner/repo","workspaceUuid":"workspace-uuid","repositoryUuid":"repo-uuid"}',
  }[platform];
  const fingerprint = {
    continue: `{"cloneFromKiloSessionId":"ses_source","repo":${repo},"model":"model","mode":"code","organizationId":"org-1"}`,
    bare: '{"prompt":"Saved prompt","mode":"code","model":"model","repo":"owner/repo","autoCommit":false,"organizationId":"org-1","profileId":null,"attachments":null}',
    ordinary: `{"prompt":"Saved prompt","mode":"code","model":"model","repo":${repo},"autoCommit":false,"organizationId":"org-1","profileId":null,"attachments":null}`,
  }[entry];
  const repositoryInputs: Record<CodeReviewPlatform, ProviderPrepareInput> = {
    github: { githubRepo: 'owner/repo' },
    gitlab: { gitlabProject: 'owner/nested/repo' },
    bitbucket: {
      bitbucketRepo: {
        fullName: 'owner/repo',
        workspaceUuid: 'workspace-uuid',
        repositoryUuid: 'repo-uuid',
      },
    },
  };
  const input = {
    ...(entry === 'continue'
      ? { cloneFromKiloSessionId: 'ses_source' }
      : { prompt: 'Saved prompt', initialMessageId: 'msg_before_upgrade' }),
    mode: 'code',
    model: 'model',
    autoCommit: false,
    autoInitiate: true,
    operationKey: 'before-upgrade',
    ...repositoryInputs[platform],
    ...(invalid ? { githubIntegrationId: 'unresolved-pin' } : {}),
  };
  const row = { taxonomy: 'safe-retry', operationKey: 'before-upgrade', fingerprint, input };
  native.rows.set(`outbox:user-1\0${fingerprint}`, {
    scope: 'outbox:user-1',
    k: fingerprint,
    v: JSON.stringify(row),
  });
  acceptedSessions.set('before-upgrade', 'session-before-upgrade');
  return row;
}

it('quarantines competing legacy keys instead of selecting one admitted operation', async () => {
  const bare = seedLegacyRecord('bare');
  const scoped = seedLegacyRecord('ordinary');
  const competing = {
    ...scoped,
    operationKey: 'another-original-key',
    input: { ...scoped.input, operationKey: 'another-original-key' },
  };
  native.rows.set(`outbox:user-1\0${competing.fingerprint}`, {
    scope: 'outbox:user-1',
    k: competing.fingerprint,
    v: JSON.stringify(competing),
  });
  acceptedSessions.set(competing.operationKey, 'another-original-session');
  await mount();
  await start();
  expect(native.errors.at(-1)).toBe('agentChat.newSession.legacyLaunchUnavailable');
  expect(native.alert).toBeNull();
  expect(requests).toEqual([]);
  expect(acceptedSessions.size).toBe(2);
  expect(native.nextKey).toBe(0);
  expect(new Set(await storedKeys())).toEqual(new Set([bare.operationKey, competing.operationKey]));
  expect(native.draft).toBe('Saved prompt');
  expect(form().isCreating).toBe(false);
});

async function answerLegacyAlert(retry = true) {
  const alert = native.alert;
  expect(alert?.title).toBe('agentChat.newSession.legacyLaunchTitle');
  expect(alert?.message).toBe('agentChat.newSession.legacyLaunchMessage');
  const button = alert?.buttons.find(
    action => action.text === (retry ? 'agentChat.newSession.retryLegacyLaunch' : 'common.cancel')
  );
  if (!button) {
    throw new Error('Legacy recovery action is absent');
  }
  native.alert = null;
  await act(async () => {
    button.onPress();
  });
}

it.each([
  ['bare', 'github'],
  ['ordinary', 'github'],
  ['continue', 'github'],
  ['ordinary', 'gitlab'],
  ['continue', 'gitlab'],
  ['ordinary', 'bitbucket'],
  ['continue', 'bitbucket'],
] as const)(
  'recovers the serialized %s %s launch with its admitted input across a lost response and remount',
  async (entry, platform) => {
    const row = seedLegacyRecord(entry, false, platform);
    await mount();
    await chooseBranch('feature/b4');
    await start();
    expect(requests).toEqual([]);
    expect(native.nextKey).toBe(0);
    expect(await listOutboxRows('user-1')).toEqual([row]);
    await answerLegacyAlert(false);
    expect(form().isCreating).toBe(false);
    expect(native.draft).toBe('Saved prompt');
    expect(requests).toEqual([]);
    await start();
    await answerLegacyAlert();
    const first = requests[0];
    expect(first?.input).toEqual({ ...row.input, organizationId: 'org-1' });
    expect(acceptedSessions.size).toBe(1);
    await act(async () => {
      first?.response.reject(new Error('Lost response'));
    });
    expect(await listOutboxRows('user-1')).toEqual([row]);
    expect(native.draft).toBe('Saved prompt');
    await act(() => {
      screen?.unmount();
    });
    screen = undefined;
    await mount();
    await chooseBranch('feature/next');
    await start();
    expect(requests).toHaveLength(1);
    await answerLegacyAlert();
    expect(requests[1]?.input).toEqual({ ...row.input, organizationId: 'org-1' });
    expect(acceptedSessions.size).toBe(1);
    expect(native.nextKey).toBe(0);
    await act(async () => {
      requests[1]?.response.resolve({ kiloSessionId: 'session-before-upgrade' });
    });
    expect(native.path).toContain('agent-chat/session-before-upgrade');
    expect(await listOutboxRows('user-1')).toEqual([]);
    expect(native.draft).toBe(entry === 'continue' ? 'Saved prompt' : null);
  }
);

it.each(['ordinary', 'continue'] as const)(
  'blocks an unsafe serialized %s record without replacing its key or saved input',
  async entry => {
    const row = seedLegacyRecord(entry, true);
    async function attemptUnsafeRetry() {
      await mount();
      await start();
      expect(native.errors.at(-1)).toBe('agentChat.newSession.legacyLaunchUnavailable');
      expect(native.alert).toBeNull();
      expect(requests).toEqual([]);
      expect(acceptedSessions.size).toBe(1);
      expect(native.nextKey).toBe(0);
      expect(await listOutboxRows('user-1')).toEqual([row]);
      expect(native.draft).toBe('Saved prompt');
      expect(form().isCreating).toBe(false);
      await act(() => {
        screen?.unmount();
      });
      screen = undefined;
    }
    await attemptUnsafeRetry();
    await attemptUnsafeRetry();
  }
);

it.each(['ordinary', 'continue'] as const)(
  'keeps an unresolved %s legacy operation after the server rejects its original identity',
  async entry => {
    const row = seedLegacyRecord(entry);
    await mount();
    await start();
    await answerLegacyAlert();
    await act(async () => {
      requests[0]?.response.reject(
        Object.assign(new Error('Ambiguous repository identity'), { data: { code: 'BAD_REQUEST' } })
      );
    });
    expect(native.errors.at(-1)).toBe('Ambiguous repository identity');
    expect(await listOutboxRows('user-1')).toEqual([row]);
    expect(native.draft).toBe('Saved prompt');
    await start();
    expect(requests).toHaveLength(1);
    expect(native.nextKey).toBe(0);
    await answerLegacyAlert(false);
    expect(form().isCreating).toBe(false);
    expect(acceptedSessions.size).toBe(1);
  }
);

it.each(['repository', 'integration', 'instance', 'branch'])(
  'retires Continue completion after %s invalidation and keeps the replacement form and retry row',
  async change => {
    native.platform = 'gitlab';
    native.selectedRepo = currentRepository().key;
    native.draft = 'An unrelated ordinary draft';
    await mount();
    await chooseBranch('feature/b4');
    await start();
    const first = requests[0];
    if (!first) {
      throw new Error('First launch was not admitted');
    }
    if (change === 'repository') {
      native.repositoryId = '84';
    } else if (change === 'integration') {
      native.integrationId = 'integration-2';
    } else if (change === 'instance') {
      native.gitlabInstanceUrl = 'https://git.example.com/other';
    } else {
      native.branches = ['develop', 'feature/next'];
    }
    await act(() => {
      screen?.update(createElement(NewSessionScreenBody));
    });
    expect(form().isCreating).toBe(false);
    expect(form().isStartDisabled).toBe(true);
    if (change !== 'branch') {
      await act(() => {
        form().onChangeRepo(currentRepository().key);
      });
    }
    await chooseBranch('feature/next');
    await start();
    const second = requests[1];
    if (!second) {
      throw new Error('Replacement launch was not admitted');
    }
    const replacementKey = form().selectedRepo;
    await act(async () => {
      first.response.resolve({ kiloSessionId: 'session-retired' });
    });
    expect(native.path).toBe('/continue');
    expect(form().selectedRepo).toBe(replacementKey);
    expect(form().isCreating).toBe(true);
    expect(form().isStartDisabled).toBe(true);
    expect(JSON.stringify(screen?.toJSON())).toContain('"text":"feature/next"');
    expect(native.draft).toBe('An unrelated ordinary draft');
    expect(native.errors).toEqual([]);
    expect(new Set(await storedKeys())).toEqual(
      new Set([first.input.operationKey, second.input.operationKey])
    );
    goBack();
    expect(native.path).toBe('/continue');
    await act(async () => {
      second.response.resolve({ kiloSessionId: 'session-replacement' });
    });
    expect(native.path).toContain('agent-chat/session-replacement');
    expect(await storedKeys()).toEqual([first.input.operationKey]);
    expect(native.draft).toBe('An unrelated ordinary draft');
  }
);

it.each([
  ['BAD_REQUEST', 'invalidRepositorySelection'],
  ['NOT_FOUND', 'repositoryUnavailable'],
])(
  'keeps repository reselection available after %s without reconnecting',
  async (code, message) => {
    native.cloneFromKiloSessionId = '';
    native.draft = 'Keep the resource recovery prompt';
    native.branchError = Object.assign(new Error('Unavailable'), { data: { code } });
    await mount();
    const text = JSON.stringify(screen?.toJSON());
    expect(text).toContain(`agentChat.newSession.${message}`);
    expect(text).not.toContain('agentChat.newSession.openGithub');
    expect(text).not.toContain('branchAccessDenied');
    const picker = screen?.root
      .findAllByType('Pressable')
      .map(node => node.props as { accessibilityLabel?: string; disabled?: boolean })
      .find(props => props.accessibilityLabel?.startsWith('agentChat.repoPicker.accessibility'));
    expect(picker?.disabled).toBe(false);
    expect(form().isStartDisabled).toBe(true);
    native.repositoryId = '84';
    native.branchError = null;
    await act(() => {
      form().onChangeRepo(currentRepository().key);
    });
    await start();
    expect(requests[0]?.input.prompt).toBe('Keep the resource recovery prompt');
    await act(async () => {
      requests[0]?.response.resolve({ kiloSessionId: 'session-reselected' });
    });
    expect(native.path).toContain('agent-chat/session-reselected');
  }
);

it.each(['ordinary', 'continue'] as const)(
  'retires %s legacy consent after discovery invalidates the selection',
  async entry => {
    const row = seedLegacyRecord(entry);
    await mount();
    await start();
    expect(requests).toEqual([]);
    native.integrationId = 'replacement-integration';
    await act(() => {
      screen?.update(createElement(NewSessionScreenBody));
    });
    await answerLegacyAlert();
    expect(requests).toEqual([]);
    expect(native.nextKey).toBe(0);
    expect(await listOutboxRows('user-1')).toEqual([row]);
    expect(native.draft).toBe('Saved prompt');
    expect(form().isCreating).toBe(false);
    expect(form().isStartDisabled).toBe(true);
  }
);
