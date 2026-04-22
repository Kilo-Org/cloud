export type {
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
  EventMessageUpdated,
  EventMessagePartUpdated,
  EventMessagePartRemoved,
  EventSessionStatus,
  EventSessionCreated,
  EventSessionUpdated,
} from '@/types/opencode.gen';

import type { UserMessage, AssistantMessage, Part } from '@/types/opencode.gen';

// ---------------------------------------------------------------------------
// Branded session ID types — prevent accidental mixing of kilo vs cloud agent IDs
// ---------------------------------------------------------------------------

/** Kilo platform session ID (e.g. `ses_abc123…`). Used for DB lookups and CLI sessions. */
export type KiloSessionId = string & { readonly __brand: 'KiloSessionId' };
/** Cloud Agent session ID (e.g. `agent_12345678-1234-…`). Used for DO routing and tRPC calls. */
export type CloudAgentSessionId = string & { readonly __brand: 'CloudAgentSessionId' };

export type MessageInfo = UserMessage | AssistantMessage;

export type ProcessedMessage = {
  info: MessageInfo;
  parts: Part[];
};

/** Minimal session identity — only the fields the SDK actually reads. */
export type SessionInfo = {
  id: string;
  parentID?: string;
};

export type SessionPhase =
  | { status: 'connecting' }
  | { status: 'streaming' }
  | { status: 'idle' }
  | { status: 'stopped'; reason: 'interrupted' | 'error' | 'disconnected' }
  | { status: 'retrying'; attempt: number; message: string; next: number };

// ---------------------------------------------------------------------------
// Service state types — separated from chat data
// ---------------------------------------------------------------------------

import type { QuestionInfo } from '@/types/opencode.gen';

/** Real-time activity indicator — renders as a separate spinner/indicator. */
export type SessionActivity =
  | { type: 'connecting' }
  | { type: 'busy' }
  | { type: 'idle' }
  | { type: 'retrying'; attempt: number; message: string };

/** Lifecycle outcome — drives bottom bar content (one thing at a time). */
export type AgentStatus =
  | { type: 'idle' }
  | { type: 'autocommit'; step: string; message: string }
  | { type: 'error'; message: string }
  | { type: 'disconnected' }
  | { type: 'interrupted' };

/** Cloud infrastructure status — independent from agent activity. */
export type CloudStatus =
  | { type: 'preparing'; step?: string; message?: string }
  | { type: 'ready' }
  | { type: 'finalizing'; step?: string; message?: string }
  | { type: 'error'; message: string };

export type QuestionState = {
  requestId: string;
  questions?: QuestionInfo[];
};

export type PermissionState = {
  requestId: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
};

export type SuggestionAction = {
  label: string;
  description?: string;
  prompt: string;
};

export type SuggestionState = {
  requestId: string;
  text: string;
  actions: SuggestionAction[];
  /** Tool call ID that emitted this suggestion, when available. */
  callId?: string;
};

/** Full service state — all non-chat state in one place. */
export type ServiceStateSnapshot = {
  activity: SessionActivity;
  status: AgentStatus;
  cloudStatus: CloudStatus | null;
  sessionInfo: SessionInfo | null;
  question: QuestionState | null;
  permission: PermissionState | null;
  suggestion: SuggestionState | null;
};

// ---------------------------------------------------------------------------
// Session resolution — determines session type and transport routing
// ---------------------------------------------------------------------------

export type ResolvedSession =
  | { type: 'remote'; kiloSessionId: KiloSessionId }
  | { type: 'cloud-agent'; kiloSessionId: KiloSessionId; cloudAgentSessionId: CloudAgentSessionId }
  | { type: 'read-only'; kiloSessionId: KiloSessionId };

// ---------------------------------------------------------------------------
// Historical session snapshot — used by CLI historical transport
// ---------------------------------------------------------------------------

export type SessionSnapshot = {
  info: SessionInfo;
  messages: Array<{
    info: MessageInfo;
    parts: Part[];
  }>;
};
