/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the actual screen and both creators without a DOM */
/* eslint-disable require-await, @typescript-eslint/require-await -- native storage and transport doubles return promises */
/* eslint-disable max-lines -- the screen dependencies and overlapping launch regressions share one mounted harness */
import { type ComponentProps, createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { listOutboxRows } from '@/lib/persist/mutation-outbox';
import { NewSessionConfigureForm } from './new-session-configure-form';
import { NewSessionScreenBody } from './new-session-screen-body';

type FormProps = ComponentProps<typeof NewSessionConfigureForm>;
type RemoveEvent = { data: { action: { type: string } } };
const native = vi.hoisted(() => ({
  userId: 'user-1',
  organizationId: 'org-1',
  selectedRepo: 'github:owner/repo',
  path: '/continue',
  nextKey: 0,
  errors: [] as string[],
  leaveLocked: false,
  beforeRemove: undefined as ((event: RemoveEvent) => void) | undefined,
  rows: new Map<string, { scope: string; k: string; v: string }>(),
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('./new-session-configure-form', () => ({
  NewSessionConfigureForm: (props: FormProps) => createElement('configure-form', props),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({
    organizationId: native.organizationId,
    cloneFromKiloSessionId: 'ses_source',
  }),
  useRouter: () => ({
    replace: (path: string) => {
      native.path = path;
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
  useQueryClient: () => ({}),
  useQuery: () => ({ data: { instances: [] }, isLoading: false, refetch: vi.fn() }),
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
  useNewSessionPrefillTargets: () => ({
    selectedRepo: native.selectedRepo,
    setSelectedRepo: vi.fn(),
  }),
}));
vi.mock('@/lib/use-new-session-repos', () => ({
  useNewSessionRepos: () => ({
    repositories: [{ platform: 'github', fullName: 'owner/repo', isPrivate: true }],
    recents: [],
    groups: [],
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
  clearDraft: vi.fn(),
  saveDraft: vi.fn(),
  resolvePrefillOverDraft: vi.fn(),
}));
vi.mock('@/lib/persist/use-draft-flush', () => ({ useDraftFlushOnBackground: vi.fn() }));
vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ settled: true, value: null }),
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
  useTRPC: () => ({ activeSessions: { listInstances: { queryOptions: () => ({}) } } }),
  trpcClient: {
    cloudAgentNext: { prepareSession: { mutate: prepare } },
    organizations: { cloudAgentNext: { prepareSession: { mutate: prepare } } },
  },
}));

type Payload = { operationKey: string; organizationId?: string };
const requests: {
  input: Payload;
  response: ReturnType<typeof Promise.withResolvers<{ kiloSessionId: string }>>;
}[] = [];
async function prepare(input: Payload) {
  const response = Promise.withResolvers<{ kiloSessionId: string }>();
  requests.push({ input, response });
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
  native.selectedRepo = 'github:owner/repo';
  native.path = '/continue';
  native.nextKey = 0;
  native.errors = [];
  native.leaveLocked = false;
  native.beforeRemove = undefined;
  native.rows.clear();
  requests.length = 0;
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
