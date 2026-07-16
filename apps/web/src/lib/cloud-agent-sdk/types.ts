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

export type {
  KiloSdkMessageHistory,
  KiloSdkMessageHistoryPage,
  KiloSdkStoredMessage,
} from '@kilocode/session-ingest-contracts';

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

/** Minimal session metadata — only the fields the SDK actually reads. */
export type SessionInfo = {
  id: string;
  parentID?: string;
  model?: {
    providerID: string;
    id: string;
    variant?: string;
  };
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

/**
 * Slash command catalog item from kilo. Mirrors the wire shape sent over
 * `commands.available` events — `template` is intentionally omitted because
 * kilo handles `$1`/`$2`/`$ARGUMENTS` substitution server-side.
 */
export type SlashCommandInfo = {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: 'command' | 'mcp' | 'skill';
  hints: string[];
  subtask?: boolean;
};

/** Per-user-message delivery state, tracked via server-emitted cloud.message.* events. */
export type MessageDeliveryState =
  | { status: 'queued' }
  | {
      status: 'failed';
      error: string;
      reason: 'interrupted' | 'exhausted' | 'execution';
      attempts?: number;
    };

export type PreparationAttemptStatus = 'running' | 'completed' | 'failed';
export type PreparationStepKind = 'phase' | 'setup_command';
export type PreparationStepStatus = 'running' | 'completed' | 'failed';

export type PreparationStepSnapshot = {
  id: string;
  key: string;
  kind: PreparationStepKind;
  label: string;
  status: PreparationStepStatus;
  startedAt: number;
  completedAt?: number;
  revision: number;
  latestDetail?: string;
  safeError?: string;
  command?: string;
  commandIndex?: number;
  commandCount?: number;
  outputTail?: string;
  outputTruncated?: boolean;
  exitCode?: number;
};

export type PreparationAttempt = {
  id: string;
  triggerMessageId: string;
  status: PreparationAttemptStatus;
  startedAt: number;
  completedAt?: number;
  safeError?: string;
  revision: number;
  steps: PreparationStepSnapshot[];
};

/** Full service state — all non-chat state in one place. */
export type ServiceStateSnapshot = {
  activity: SessionActivity;
  status: AgentStatus;
  cloudStatus: CloudStatus | null;
  /** @deprecated Legacy transient setup output. v2 preparation uses preparationAttempts. */
  setupLog: readonly string[];
  preparationAttempts: readonly PreparationAttempt[];
  sessionInfo: SessionInfo | null;
  question: QuestionState | null;
  permission: PermissionState | null;
  suggestion: SuggestionState | null;
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>;
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

/**
 * Bounded page of persisted SDK messages for a Kilo session. Returned by the
 * `fetchSnapshotPage` seam that the mobile client uses to walk the history
 * one page at a time. `nextCursor` is the opaque cursor to pass to the next
 * page (or `null` when the history has been fully read); `omittedItemCount`
 * reports how many individual items the worker filtered out before the page
 * left the DO so the UI can faithfully report omissions.
 */
export type SessionSnapshotPage = {
  info: SessionInfo;
  messages: SessionSnapshot['messages'];
  nextCursor: string | null;
  omittedItemCount: number;
};

/**
 * Result of a single `fetchSnapshotPage` call. The discriminated `kind` lets
 * the caller distinguish a successful bounded read from typed worker-side
 * failures (`retryable_failure` for transient DO read issues,
 * `invalid_data` for shape mismatches, `too_large` for oversize pages) so
 * retry semantics can be surfaced without inferring them from the worker's
 * text. `null` represents an access-not-found outcome (worker returns 404).
 */
export type SessionSnapshotPageOutcome =
  | (SessionSnapshotPage & { kind: 'success' })
  | { kind: 'retryable_failure' }
  | { kind: 'invalid_data' }
  | { kind: 'too_large' };

/**
 * Typed failure state for the manager's older-messages load. Mirrors the
 * worker-side `SessionSnapshotPageOutcome` failure kinds so the UI can
 * surface a Retry CTA for `retryable` and a terminal no-CTA state for
 * `invalid_data` / `too_large` without re-deriving retry semantics.
 */
export type OlderMessagesError =
  | { kind: 'retryable' }
  | { kind: 'invalid_data' }
  | { kind: 'too_large' };
