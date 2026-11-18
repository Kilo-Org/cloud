/**
 * Cloud Agent Next Types
 *
 * Type definitions for cloud agent chat messages and related structures.
 * Uses Message + Part[] format.
 *
 * IMPORTANT: This file should NOT import from other cloud-agent-next modules
 * to avoid circular dependencies. It serves as the base types file.
 */

import * as z from 'zod';

import type { AssociatedPr } from './utils/github-pr-link';

import type {
  Message as OpenCodeMessage,
  UserMessage as OpenCodeUserMessage,
  AssistantMessage as OpenCodeAssistantMessage,
  Part,
  TextPart,
  ToolPart,
  FilePart,
  ReasoningPart,
  StepStartPart,
  StepFinishPart,
  CompactionPart,
  PatchPart,
  ToolState,
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
  EventMessageUpdated,
  EventMessagePartUpdated,
  EventMessagePartRemoved,
  EventSessionStatus,
  EventSessionCreated,
  EventSessionUpdated,
  Session,
  SessionStatus,
} from '@/types/opencode.gen';

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
  ToolState,
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
  EventMessageUpdated,
  EventMessagePartUpdated,
  EventMessagePartRemoved,
  EventSessionStatus,
  EventSessionCreated,
  EventSessionUpdated,
  Session,
  SessionStatus,
};

export type StoredMessage = {
  info: OpenCodeMessage;
  parts: Part[];
};

export type SubtaskPart = Extract<Part, { type: 'subtask' }>;

export function isTextPart(part: Part): part is TextPart {
  return part.type === 'text';
}

export function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool';
}

export function isFilePart(part: Part): part is FilePart {
  return part.type === 'file';
}

export function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === 'reasoning';
}

function hasVisibleReasoningText(text: string | undefined): boolean {
  if (text == null) return false;
  return (
    text
      .replaceAll('[REDACTED]', '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace('<!--', '')
      .trim() !== ''
  );
}

export function shouldRenderReasoningPart(part: Part): boolean {
  return isReasoningPart(part) && hasVisibleReasoningText(part.text);
}

export function isStepStartPart(part: Part): part is StepStartPart {
  return part.type === 'step-start';
}

export function isStepFinishPart(part: Part): part is StepFinishPart {
  return part.type === 'step-finish';
}

export function isSubtaskPart(part: Part): part is SubtaskPart {
  return part.type === 'subtask';
}

export function isCompactionPart(part: Part): part is CompactionPart {
  return part.type === 'compaction';
}

export function isPatchPart(part: Part): part is PatchPart {
  return part.type === 'patch';
}

export function isUserMessage(message: OpenCodeMessage): message is OpenCodeUserMessage {
  return message.role === 'user';
}

export function isAssistantMessage(message: OpenCodeMessage): message is OpenCodeAssistantMessage {
  return message.role === 'assistant';
}

/**
 * Check if a part is currently streaming (no end time).
 * V2 streaming detection: absence of time.end indicates streaming.
 */
export function isPartStreaming(part: Part): boolean {
  if (isTextPart(part) || isReasoningPart(part)) {
    return part.time !== undefined && part.time.end === undefined;
  }
  if (isToolPart(part)) {
    return part.state.status === 'pending' || part.state.status === 'running';
  }
  return false;
}

export function isMessageStreaming(message: StoredMessage): boolean {
  if (isAssistantMessage(message.info) && message.info.error) return false;
  if (isAssistantMessage(message.info) && !message.info.time.completed) return true;
  return message.parts.some(isPartStreaming);
}

/**
 * Valid mode values for cloud agent sessions. Includes the cloud-agent-next
 * built-in slugs plus any custom slug from a session's profile-scoped
 * `runtimeAgents`. `(string & {})` keeps the literal completions while still
 * accepting custom slugs.
 */
export type AgentMode =
  | 'code'
  | 'plan'
  | 'debug'
  | 'orchestrator'
  | 'ask'
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  | (string & {});

export type StreamEventEnvelope = {
  eventId: number;
  executionId: string;
  sessionId: string;
  streamEventType: string;
  timestamp: string;
  data: unknown;
};

export type StreamEventType =
  | 'message.updated'
  | 'message.part.updated'
  | 'message.part.removed'
  | 'session.status'
  | 'session.created'
  | 'session.updated'
  | 'session.error'
  | 'session.idle';

export type ResumeConfig = {
  mode: AgentMode;
  model: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
};

export type ToolExecution = {
  toolName: string; // Tool identifier (bash, read, edit, etc.)
  input: Record<string, unknown>; // Tool input parameters
  output?: string; // Tool output (when complete)
  error?: string; // Error message (if failed)
  timestamp: string; // ISO timestamp
};

export type SessionConfig = {
  sessionId: string; // Session identifier (agent_xxx)
  repository: string; // GitHub repo (owner/repo format)
  mode: string;
  model: string;
};

export type SessionStartConfig = {
  githubRepo: string;
  prompt: string;
  mode: AgentMode;
  model: string;
  githubToken?: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
  upstreamBranch?: string;
};

/**
 * Stored session interface
 * Used for localStorage persistence
 */
/**
 * Legacy message type for StoredSession.messages field.
 * Note: This field is always empty in practice (not used for display).
 */
type LegacySessionMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  toolExecutions?: ToolExecution[];
};

export type CloudSessionCreationOperation = {
  intent: string;
  operationKey: string;
};

export function getCloudSessionCreationOperation(
  current: CloudSessionCreationOperation | null | undefined,
  intent: string,
  createOperationKey: () => string
): CloudSessionCreationOperation {
  if (current?.intent === intent) return current;
  return { intent, operationKey: createOperationKey() };
}

/** Another attempt with the same operation key is still running on the server. */
export function isCloudSessionCreationInProgressError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return false;
  if (typeof error.data !== 'object' || error.data === null || !('code' in error.data)) {
    return false;
  }
  return (
    error.data.code === 'CONFLICT' &&
    'message' in error &&
    (error.message === 'creation_in_progress' || error.message === 'operation_in_progress')
  );
}

export function isAmbiguousCloudSessionCreationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return true;
  if (typeof error.data !== 'object' || error.data === null || !('code' in error.data)) return true;
  if (typeof error.data.code !== 'string') return true;

  if (error.data.code === 'CONFLICT') {
    return (
      'message' in error &&
      (error.message === 'creation_in_progress' || error.message === 'operation_in_progress')
    );
  }

  return [
    'TIMEOUT',
    'INTERNAL_SERVER_ERROR',
    'BAD_GATEWAY',
    'SERVICE_UNAVAILABLE',
    'GATEWAY_TIMEOUT',
  ].includes(error.data.code);
}

export type StoredSession = {
  sessionId: string;
  repository: string;
  prompt: string;
  mode: string;
  model: string;
  status: 'active' | 'completed' | 'error';
  createdAt: string;
  updatedAt: string;
  /** Real user or agent activity; falls back to `createdAt` when absent. */
  lastActivityAt?: string | null;
  /** @deprecated Always empty - use StoredMessage[] from session loading instead */
  messages: LegacySessionMessage[];
  envVars?: Record<string, string>;
  setupCommands?: string[];
  /** Cloud agent session ID - when present, indicates this session ran in cloud */
  cloudAgentSessionId?: string | null;
  /** Platform where session was created: 'cli', 'cloud-agent', 'agent-manager', or extension identifier */
  createdOnPlatform?: string | null;
  /** Git branch name, shown separately from repository in the sidebar */
  branch?: string | null;
  worktreeId?: string | null;
  sessionStatus?: string | null;
  sessionStatusUpdatedAt?: string | null;
  latestRunFailureKind?: 'failed' | 'system_interrupted' | null;
  latestRunTerminalAt?: string | null;
  /**
   * Associated GitHub pull request for this session's own verified link, if
   * any.
   * - `AssociatedPr`: the session's own stored link passed GitHub verification.
   *   Live cache fields (title, state, review decision) are served once the
   *   per-PR cache has synced; a verified link whose cache row is missing
   *   renders as a pending partial (state `unknown`) so it can be refreshed.
   * - `null`: no stored link, or a stored link GitHub has not verified, so
   *   there is nothing trustworthy to show.
   * - `undefined`: PR data was not requested or not yet loaded for this row.
   */
  associatedPr?: AssociatedPr | null;
  /** Set only for a session this client created and the server does not list yet. */
  localSync?: 'syncing' | 'synced' | 'failed';
};

export const ToolExecutionSchema = z.object({
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  output: z.string().optional(),
  error: z.string().optional(),
  timestamp: z.string(),
});

export type ParsedStreamEvent =
  | { type: 'message.updated'; data: EventMessageUpdated['properties'] }
  | { type: 'message.part.updated'; data: EventMessagePartUpdated['properties'] }
  | { type: 'message.part.removed'; data: EventMessagePartRemoved['properties'] }
  | { type: 'session.status'; data: EventSessionStatus['properties'] }
  | { type: 'session.created'; data: EventSessionCreated['properties'] }
  | { type: 'session.updated'; data: EventSessionUpdated['properties'] }
  | { type: 'session.error'; data: { sessionID?: string; error?: unknown } }
  | { type: 'session.idle'; data: { sessionID: string } };
