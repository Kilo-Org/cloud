import { atom } from 'jotai';
import {
  type AgentStatus,
  type ChildSessionHydrationState,
  type CloudAgentModelOverride,
  type CloudAgentSessionId,
  type CloudStatus,
  type ContextUsage,
  type CustomerBillingFailure,
  type FetchedSessionData,
  type KiloSessionId,
  type MessageDeliveryState,
  type OlderMessagesError,
  type PermissionState,
  type PreparationAttempt,
  type QuestionState,
  type RemoteModelOverride,
  type RemoteModelState,
  type SessionActivity,
  type SessionCommit,
  type SessionConfig,
  type SessionInfo,
  type SessionManager,
  type SessionStatusIndicator,
  type SlashCommandCatalogStatus,
  type SlashCommandInfo,
  type StandalonePermission,
  type StandaloneQuestion,
  type StandaloneSuggestion,
  type StoredMessage,
  type SuggestionState,
  type UnreadablePermissionState,
  type WorktreeChangesRefresh,
} from '@kilocode/cloud-agent-sdk';
import { type RemoteCommandState } from '@kilocode/cloud-agent-sdk/remote-command-catalog';
import { cloudAgentId, kiloId } from '@kilocode/cloud-agent-sdk/test-helpers';

/**
 * The agent chat screen — transcript and composer — against one fixed
 * transcript, for a design-gate cell. The transcript keeps a refused message as
 * an undelivered bubble with Retry and leaves the composer empty.
 *
 * Nothing here talks to a transport. Every atom holds one still layout and every
 * method is inert, so a cell can bracket the screen and compare two revisions of
 * it without a live session that keeps moving behind it.
 *
 * The sibling state — the same text restored in the composer, with the cause
 * stated above it — is not reproduced here: the screen reads its draft from the
 * durable store under the signed-in account, so a fixture cannot seed it without
 * writing into that account's drafts. That state is proven by device captures
 * and the component suites instead.
 */
export type AgentChatFixtureVariant = 'undelivered';

export const AGENT_CHAT_FIXTURE_SESSION_ID: KiloSessionId = kiloId(
  'ses_designGateAgentChatFixture0001'
);

/** The prompt the refused message carries. */
export const AGENT_CHAT_FIXTURE_PROMPT = 'Deploy the fix to staging';

/** The assistant turn before the prompt, so the transcript has a finished burst. */
const answer: StoredMessage = {
  info: {
    id: 'msg_designGateAnswer',
    sessionID: AGENT_CHAT_FIXTURE_SESSION_ID,
    role: 'assistant',
    time: { created: 1_700_000_000_000, completed: 1_700_000_030_000 },
    parentID: 'msg_designGateOpening',
    modelID: 'auto-efficient',
    providerID: 'kilo',
    mode: 'code',
    agent: 'code',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0.0012,
    tokens: { input: 1200, output: 340, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [
    {
      id: 'prt_designGateAnswer',
      sessionID: AGENT_CHAT_FIXTURE_SESSION_ID,
      messageID: 'msg_designGateAnswer',
      type: 'text',
      text: 'Staging runs the previous build. The deploy is queued behind the migration.',
    },
  ],
};

const opening: StoredMessage = {
  info: {
    id: 'msg_designGateOpening',
    sessionID: AGENT_CHAT_FIXTURE_SESSION_ID,
    role: 'user',
    time: { created: 1_699_999_940_000 },
    agent: 'code',
    model: { providerID: 'kilo', modelID: 'auto-efficient' },
  },
  parts: [
    {
      id: 'prt_designGateOpening',
      sessionID: AGENT_CHAT_FIXTURE_SESSION_ID,
      messageID: 'msg_designGateOpening',
      type: 'text',
      text: 'Where does the staging deploy stand?',
    },
  ],
};

const refused: StoredMessage = {
  info: {
    id: 'msg_designGateRefused',
    sessionID: AGENT_CHAT_FIXTURE_SESSION_ID,
    role: 'user',
    time: { created: 1_700_000_060_000 },
    agent: 'code',
    model: { providerID: 'kilo', modelID: 'auto-efficient' },
  },
  parts: [
    {
      id: 'prt_designGateRefused',
      sessionID: AGENT_CHAT_FIXTURE_SESSION_ID,
      messageID: 'msg_designGateRefused',
      type: 'text',
      text: AGENT_CHAT_FIXTURE_PROMPT,
    },
  ],
};

const fetched: FetchedSessionData = {
  kiloSessionId: AGENT_CHAT_FIXTURE_SESSION_ID,
  cloudAgentSessionId: cloudAgentId('cag_designGateAgentChat'),
  title: 'Staging deploy',
  organizationId: null,
  profileId: null,
  gitUrl: null,
  gitBranch: 'main',
  mode: 'code',
  model: 'auto-efficient',
  variant: null,
  repository: 'kilo-fixture/staging',
  isInitiated: true,
  isPreparingAsync: false,
  prompt: null,
  initialMessageId: null,
  associatedPr: null,
};

const sessionConfig: SessionConfig = {
  sessionId: cloudAgentId('cag_designGateAgentChat'),
  repository: 'kilo-fixture/staging',
  mode: 'code',
  model: 'auto-efficient',
  providerID: 'kilo',
  variant: null,
  runtimeAgents: [],
};

const undeliveredEntry: MessageDeliveryState = {
  status: 'failed',
  error: 'The message could not be delivered',
  reason: 'exhausted',
};

/**
 * A writable atom that accepts one fixed value set and can never leave it: the
 * screen calls setters, and a fixture must not react to them.
 */
type FixedValue<T> = { readonly held: T };

// The cloud-agent pick is a model id, while the observed selection and the remote
// override are provider-qualified model refs, so both nulls are typed by shape.
type FixtureModelSelection = { model: { providerID: string; modelID: string }; variant?: string };
const noRemoteOverride: RemoteModelOverride | null = null;
const noObservedModel: FixtureModelSelection | null = null;
const noCloudOverride: CloudAgentModelOverride | null = null;
const noOlderMessagesError: OlderMessagesError | null = null;
type FixtureDeliveredPrompt = { messageId: string; text: string; sequence: number };
const noDelivered: FixtureDeliveredPrompt | null = null;
const noBilling: CustomerBillingFailure | null = null;
const noWorktreeRefresh: WorktreeChangesRefresh | null = null;

function fixed<T>(value: T) {
  // The value rides in an object so a function value stays a value: `atom(fn)`
  // would read it as a getter.
  const base = atom<FixedValue<T>>({ held: value });
  // The manager's own writable atoms declare a `void` write result.
  // eslint-disable-next-line typescript/no-invalid-void-type -- matches the manager atom type
  return atom<T, [T], void>(
    get => get(base).held,
    (_get, set, next: T) => {
      set(base, { held: next });
    }
  );
}

/* eslint-disable require-await -- the fixture's methods settle without work, one per manager member */

/**
 * The session manager the real screen mounts against, typed as the product's own
 * interface so a member the screen starts reading is caught here, not on device.
 */
export function createAgentChatFixtureManager(): SessionManager {
  const messages: StoredMessage[] = [opening, answer, refused];
  const pending = new Map<string, MessageDeliveryState>([[refused.info.id, undeliveredEntry]]);
  const idle = async (): Promise<void> => undefined;
  return {
    switchSession: async () => undefined,
    hydrateChildSession: async () => undefined,
    loadOlderChildMessages: async () => undefined,
    loadOlderMessages: async () => undefined,
    trimRetainedHistory: () => undefined,
    updateFetchedAssociatedPr: () => undefined,
    send: async () => false,
    setRemoteModelOverride: () => undefined,
    setCloudAgentModelOverride: () => undefined,
    retryRemoteModels: () => undefined,
    retryRemoteCommands: () => undefined,
    createRemoteSession: async () => AGENT_CHAT_FIXTURE_SESSION_ID,
    exitRemoteSession: async () => undefined,
    interrupt: async () => undefined,
    cancelQueuedMessage: async () => ({ dropped: false }),
    clearTranscript: () => undefined,
    answerQuestion: idle,
    rejectQuestion: idle,
    respondToPermission: idle,
    acceptSuggestion: idle,
    dismissSuggestion: idle,
    clearFailedMessage: () => undefined,
    markMessageSuperseded: () => undefined,
    unmarkMessageSuperseded: () => undefined,
    createAndStart: async () => undefined,
    clearError: () => undefined,
    destroy: () => undefined,
    atoms: {
      isStreaming: fixed(false),
      isLoading: fixed(false),
      isRefreshingCachedTranscript: fixed(false),
      cachedTranscriptSessionId: fixed<KiloSessionId | null>(null),
      isReplayingLiveHistory: fixed(false),
      isReadOnly: fixed(false),
      supportsAttachments: fixed(true),
      activeSessionType: fixed<'cloud-agent' | 'remote' | 'read-only' | null>('cloud-agent'),
      remoteModelState: fixed<RemoteModelState>({
        ownerConnectionId: null,
        protocol: 'v1',
        refresh: 'idle',
      }),
      remoteCommandState: fixed<RemoteCommandState>({
        ownerConnectionId: null,
        refresh: 'idle',
        commands: [],
      }),
      observedModel: fixed(noObservedModel),
      remoteModelOverride: fixed(noRemoteOverride),
      cloudAgentModelOverride: fixed(noCloudOverride),
      canSend: fixed(true),
      canInterrupt: fixed(false),
      statusIndicator: fixed<SessionStatusIndicator | null>(null),
      error: fixed<string | null>(null),
      question: fixed<QuestionState | null>(null),
      sessionInfo: fixed<SessionInfo | null>({ id: AGENT_CHAT_FIXTURE_SESSION_ID }),
      sessionId: fixed<CloudAgentSessionId | null>(cloudAgentId('cag_designGateAgentChat')),
      activity: fixed<SessionActivity>({ type: 'idle' }),
      agentStatus: fixed<AgentStatus>({ type: 'idle' }),
      cloudStatus: fixed<CloudStatus | null>(null),
      setupLog: fixed<readonly string[]>([]),
      preparationAttempts: fixed<readonly PreparationAttempt[]>([]),
      commits: fixed<readonly SessionCommit[]>([]),
      sessionConfig: fixed<SessionConfig | null>(sessionConfig),
      sessionType: fixed<'cloud-agent' | 'remote' | 'read-only' | null>('cloud-agent'),
      chatUI: fixed<{ shouldAutoScroll: boolean }>({ shouldAutoScroll: true }),
      activeQuestion: fixed<StandaloneQuestion | null>(null),
      permission: fixed<PermissionState | null>(null),
      activePermission: fixed<StandalonePermission | null>(null),
      pendingQuestions: fixed<readonly StandaloneQuestion[]>([]),
      pendingPermissions: fixed<readonly StandalonePermission[]>([]),
      unreadablePermissions: fixed<readonly UnreadablePermissionState[]>([]),
      suggestion: fixed<SuggestionState | null>(null),
      activeSuggestion: fixed<StandaloneSuggestion | null>(null),
      pendingMessages: fixed<ReadonlyMap<string, MessageDeliveryState>>(pending),
      sendingMessageIds: fixed<ReadonlySet<string>>(new Set<string>()),
      failedPrompt: fixed<string | null>(null),
      billingFailure: fixed(noBilling),
      deliveredFailedPrompt: fixed(noDelivered),
      fetchedSessionData: fixed<FetchedSessionData | null>(fetched),
      availableCommands: fixed<SlashCommandInfo[]>([]),
      availableCommandsCatalogStatus: fixed<SlashCommandCatalogStatus | null>(null),
      worktreeChangesRefresh: fixed(noWorktreeRefresh),
      messagesList: atom(messages),
      staticMessages: atom(messages),
      dynamicMessages: atom<StoredMessage[]>([]),
      totalCost: atom(0.0012),
      contextUsage: atom<ContextUsage | undefined>(undefined),
      childMessages: fixed<(childSessionId: string) => StoredMessage[]>(() => []),
      childSessionHydrationState: fixed<(childSessionId: string) => ChildSessionHydrationState>(
        () => ({ status: 'idle' })
      ),
      childSessionError: fixed<(childSessionId: string) => string | null>(() => null),
      hasOlderMessages: fixed(false),
      isLoadingOlderMessages: fixed(false),
      olderMessagesError: fixed(noOlderMessagesError),
      olderMessagesOmittedItemCount: fixed(0),
      transcriptCleared: fixed(false),
      resolvedDeliveryFailures: fixed<ReadonlySet<string>>(new Set<string>()),
      supersededInFlightMessageIds: fixed<ReadonlySet<string>>(new Set<string>()),
    },
  };
}
