export { formatError as formatSessionError } from './session-manager';
export { createSessionManager } from './session-manager';
export { CLI_MODEL_ID, cliModelLabel } from './cli-model';
export type {
  ActiveSessionType,
  SessionManager,
  SessionManagerConfig,
  SessionManagerAtoms,
  SessionStatusIndicator,
  SessionConfig,
  StandalonePermission,
  StandaloneQuestion,
  StandaloneSuggestion,
  ChildSessionHydrationState,
  StoredMessage,
  FetchedSessionData,
  AssociatedPrData,
  PrepareInput,
} from './session-manager';

export { createCloudAgentSession, REMOTE_SESSION_EXIT_NOT_SUPPORTED } from './session';
export type {
  CloudAgentSession,
  CloudAgentSessionAcceptSuggestionInput,
  CloudAgentSessionAnswerInput,
  CloudAgentSessionConfig,
  CloudAgentSessionDismissSuggestionInput,
  CloudAgentSessionRejectInput,
  CloudAgentSessionRespondToPermissionInput,
  CloudAgentSessionSendInput,
  CloudAgentSessionTransport,
  PermissionResponse,
} from './session';

export { normalize, normalizeCliEvent, isChatEvent, isServiceEvent } from './normalizer';
export type { NormalizedEvent, ChatEvent, ServiceEvent } from './normalizer';

export { reduce } from './reducer';

export { createChatProcessor } from './chat-processor';
export type { ChatProcessor } from './chat-processor';

export { configureCloudAgentSdkRuntime } from './runtime';
export type { CloudAgentSdkRuntimeOverrides } from './runtime';

export { createServiceState } from './service-state';
export type { ServiceState, ServiceStateConfig } from './service-state';

export { createCloudAgentTransport } from './cloud-agent-transport';
export type { CloudAgentTransportConfig } from './cloud-agent-transport';

export { createBaseConnection, createBrowserLifecycleHooks } from './base-connection';
export type {
  BaseConnectionConfig,
  ConnectionLifecycleHooks,
  WebSocketHeaders,
} from './base-connection';

export { createCliHistoricalTransport } from './cli-historical-transport';
export type { CliHistoricalTransportConfig } from './cli-historical-transport';

export { createCliLiveTransport } from './cli-live-transport';
export type { CliLiveTransportConfig } from './cli-live-transport';

export {
  createUserWebConnection,
  CommandDeliveredError,
  UserWebCommandError,
} from './user-web-connection';
export type {
  UserWebConnection,
  UserWebConnectionConfig,
  UserWebSessionEventName,
  UserWebSessionEventData,
  SessionEventPayload,
  UserWebCliEvent,
  UserWebSystemEvent,
} from './user-web-connection';

export { createRemoteSessionOnConnection } from './create-session';

export {
  REMOTE_MODEL_IDENTITY_MAX_LENGTH,
  REMOTE_MODEL_MAX_MODELS_PER_PROVIDER,
  REMOTE_MODEL_MAX_MODELS_TOTAL,
  REMOTE_MODEL_MAX_PROVIDERS,
  REMOTE_MODEL_MAX_VARIANTS_PER_MODEL,
  REMOTE_MODEL_MAX_VARIANTS_TOTAL,
  createModelRefKeyMap,
  getRemoteModelRecommendedRank,
  isRemoteModelRecommended,
  modelRefSchema,
  modelRefsEqual,
  modelSelectionSchema,
  remoteModelCatalogV1Schema,
  remoteModelCatalogWireV1Schema,
  sortRemoteModelCatalogProviders,
} from './remote-model-catalog';
export type {
  ModelRef,
  ModelRefKeyMap,
  ModelSelection,
  RemoteModelCatalogV1,
  RemoteModelCatalogWireV1,
  RemoteModelOverride,
  RemoteModelState,
} from './remote-model-catalog';

export type {
  CloudAgentApi,
  CloudAgentStreamTicket,
  CloudAgentStreamTicketResult,
  RemoteAttachmentPart,
  TransportFactory,
  TransportSink,
  Transport,
  TransportSendPayload,
  SendPromptPayload,
  SendCommandPayload,
} from './transport';

export { createConnection } from './cloud-agent-connection';
export type { Connection, ConnectionConfig } from './cloud-agent-connection';

export { createMemoryStorage } from './storage/memory';
export { createJotaiStorage } from './storage/jotai';
export type { JotaiSessionStorage, JotaiStore } from './storage/jotai';
export type { SessionStorage, StorageMutation } from './storage/types';

export { stripPartContentIfFile } from './part-utils';
export { splitByContiguousPrefix } from './array-utils';

export { calculateContextUsagePercentage } from './context-usage';
export type { ContextUsage } from './context-usage';

export { isNoOpCompletedPreparationAttempt } from './preparation-attempts';

export type {
  KiloSdkMessageHistory,
  KiloSdkMessageHistoryPage,
  KiloSdkStoredMessage,
  MessageInfo,
  ProcessedMessage,
  SessionPhase,
  SessionActivity,
  AgentStatus,
  CloudStatus,
  QuestionState,
  PermissionState,
  SlashCommandInfo,
  SuggestionAction,
  SuggestionState,
  MessageDeliveryState,
  PreparationAttempt,
  PreparationAttemptStatus,
  PreparationStepKind,
  PreparationStepSnapshot,
  PreparationStepStatus,
  ServiceStateSnapshot,
  SessionInfo,
  KiloSessionId,
  CloudAgentSessionId,
  ResolvedSession,
  SessionSnapshot,
  SessionSnapshotPage,
  SessionSnapshotPageOutcome,
  OlderMessagesError,
  // Re-exported opencode types
  Part,
  TextPart,
  ToolPart,
  FilePart,
  ReasoningPart,
  StepStartPart,
  StepFinishPart,
  CompactionPart,
  PatchPart,
  UserMessage,
  AssistantMessage,
  Message,
  Session,
  SessionStatus,
  QuestionInfo,
} from './types';
