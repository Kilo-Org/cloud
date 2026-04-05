export { createSessionManager, formatError as formatSessionError } from './session-manager';
export type {
  SessionManager,
  SessionManagerConfig,
  SessionManagerAtoms,
  SessionStatusIndicator,
  SessionConfig,
  StandalonePermission,
  StandaloneQuestion,
  StoredMessage,
  FetchedSessionData,
  PrepareInput,
} from './session-manager';

export { createCloudAgentSession } from './session';
export type {
  CloudAgentSession,
  CloudAgentSessionAnswerInput,
  CloudAgentSessionConfig,
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

export { createServiceState } from './service-state';
export type { ServiceState, ServiceStateConfig } from './service-state';

export { createCloudAgentTransport } from './cloud-agent-transport';
export type { CloudAgentTransportConfig } from './cloud-agent-transport';

export { createBaseConnection } from './base-connection';
export type { BaseConnectionConfig } from './base-connection';

export { createCliHistoricalTransport } from './cli-historical-transport';
export type { CliHistoricalTransportConfig } from './cli-historical-transport';

export { createCliLiveTransport } from './cli-live-transport';
export type { CliLiveTransportConfig } from './cli-live-transport';

export type { TransportSink, Transport, TransportFactory, CloudAgentApi } from './transport';

export { createConnection } from './cloud-agent-connection';
export type { Connection, ConnectionConfig } from './cloud-agent-connection';

export { createMemoryStorage } from './storage/memory';
export { createJotaiStorage } from './storage/jotai';
export type { JotaiSessionStorage, JotaiStore } from './storage/jotai';
export type { SessionStorage, StorageMutation } from './storage/types';

export type {
  MessageInfo,
  ProcessedMessage,
  SessionPhase,
  SessionActivity,
  AgentStatus,
  CloudStatus,
  QuestionState,
  PermissionState,
  ServiceStateSnapshot,
  SessionInfo,
  KiloSessionId,
  CloudAgentSessionId,
  ResolvedSession,
  SessionSnapshot,
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
