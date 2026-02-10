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

// ============================================================================
// OpenCode Types
// ============================================================================

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

// Re-export for convenience
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

// ============================================================================
// Composite Types
// ============================================================================

/**
 * StoredMessage - The message format stored in IndexedDB.
 * Contains message metadata (info) and an array of content parts.
 */
export type StoredMessage = {
  info: OpenCodeMessage;
  parts: Part[];
};

/**
 * SubtaskPart - A part representing a child session/task.
 * Extracted from the Part union for convenience.
 */
export type SubtaskPart = Extract<Part, { type: 'subtask' }>;

// ============================================================================
// Type Guards
// ============================================================================

/** Check if a part is a TextPart */
export function isTextPart(part: Part): part is TextPart {
  return part.type === 'text';
}

/** Check if a part is a ToolPart */
export function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool';
}

/** Check if a part is a FilePart */
export function isFilePart(part: Part): part is FilePart {
  return part.type === 'file';
}

/**
 * Strip large content from a FilePart to reduce memory/storage usage.
 * Removes `url` and `source.text.value` while preserving metadata.
 * The stripped part can still be identified and displayed with a placeholder.
 */
export function stripFilePartContent(part: FilePart): FilePart {
  const stripped: FilePart = {
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: 'file',
    mime: part.mime,
    filename: part.filename,
    url: '', // Strip the potentially large data URL
  };

  // Preserve source structure but strip the text content
  if (part.source) {
    stripped.source = {
      ...part.source,
      text: {
        ...part.source.text,
        value: '', // Strip the large file content
      },
    };
  }

  return stripped;
}

/**
 * Strip large content from a part.
 * - For FileParts: strips url and source.text.value
 * - For ToolParts with attachments: strips content from each attachment
 * Returns the original part unchanged for other part types.
 */
export function stripPartContentIfFile(part: Part): Part {
  if (isFilePart(part)) {
    return stripFilePartContent(part);
  }

  // Handle ToolParts with attachments in completed state
  if (isToolPart(part) && part.state.status === 'completed' && part.state.attachments) {
    const strippedAttachments = part.state.attachments.map(stripFilePartContent);
    return {
      ...part,
      state: {
        ...part.state,
        attachments: strippedAttachments,
      },
    };
  }

  return part;
}

/** Check if a part is a ReasoningPart */
export function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === 'reasoning';
}

/** Check if a part is a StepStartPart */
export function isStepStartPart(part: Part): part is StepStartPart {
  return part.type === 'step-start';
}

/** Check if a part is a StepFinishPart */
export function isStepFinishPart(part: Part): part is StepFinishPart {
  return part.type === 'step-finish';
}

/** Check if a part is a SubtaskPart */
export function isSubtaskPart(part: Part): part is SubtaskPart {
  return part.type === 'subtask';
}

/** Check if a part is a CompactionPart */
export function isCompactionPart(part: Part): part is CompactionPart {
  return part.type === 'compaction';
}

/** Check if a part is a PatchPart */
export function isPatchPart(part: Part): part is PatchPart {
  return part.type === 'patch';
}

/** Check if a message is a UserMessage */
export function isUserMessage(message: OpenCodeMessage): message is OpenCodeUserMessage {
  return message.role === 'user';
}

/** Check if a message is an AssistantMessage */
export function isAssistantMessage(message: OpenCodeMessage): message is OpenCodeAssistantMessage {
  return message.role === 'assistant';
}

/**
 * Check if a part is currently streaming (no end time).
 * V2 streaming detection: absence of time.end indicates streaming.
 */
export function isPartStreaming(part: Part): boolean {
  // TextPart has optional time
  if (isTextPart(part)) {
    return part.time !== undefined && part.time.end === undefined;
  }
  // ReasoningPart has required time
  if (isReasoningPart(part)) {
    return part.time.end === undefined;
  }
  // ToolPart - check state
  if (isToolPart(part)) {
    return part.state.status === 'pending' || part.state.status === 'running';
  }
  // Other parts don't stream
  return false;
}

/**
 * Check if any parts in a message are still streaming.
 */
export function isMessageStreaming(message: StoredMessage): boolean {
  // Check if the assistant message has a completed timestamp
  if (isAssistantMessage(message.info) && !message.info.time.completed) {
    return true;
  }
  // Check if any parts are still streaming
  return message.parts.some(isPartStreaming);
}

// ============================================================================
// Agent Mode Types
// ============================================================================

/**
 * Valid mode values for cloud agent sessions.
 * Uses new modes for cloud-agent-next.
 */
export type AgentMode = 'plan' | 'build';

// ============================================================================
// Stream Event Types
// ============================================================================

/**
 * WebSocket event envelope from cloud-agent.
 * These are the raw events received from the WebSocket stream.
 */
export type StreamEventEnvelope = {
  eventId: number;
  executionId: string;
  sessionId: string;
  streamEventType: string;
  timestamp: string;
  data: unknown;
};

/**
 * Stream event types we handle directly.
 * These map to OpenCode event types.
 */
export type StreamEventType =
  | 'message.updated'
  | 'message.part.updated'
  | 'message.part.removed'
  | 'session.status'
  | 'session.created'
  | 'session.updated'
  | 'session.error'
  | 'session.idle';

// ============================================================================
// Resume Configuration Types
// ============================================================================

/**
 * Configuration collected when resuming a CLI session in cloud-agent.
 * Used by ResumeConfigModal and session configuration logic.
 */
export type ResumeConfig = {
  mode: AgentMode;
  model: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
};

/**
 * Config shape passed to useCloudAgentStream for resuming sessions.
 * Similar to ResumeConfig but includes the repository.
 */
export type StreamResumeConfig = {
  mode: AgentMode;
  model: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
  githubRepo: string;
};

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Tool execution
 * Represents a tool/command that was executed during the session
 */
export type ToolExecution = {
  toolName: string; // Tool identifier (bash, read, edit, etc.)
  input: Record<string, unknown>; // Tool input parameters
  output?: string; // Tool output (when complete)
  error?: string; // Error message (if failed)
  timestamp: string; // ISO timestamp
};

/**
 * Session configuration
 * Stores the current session's configuration
 */
export type SessionConfig = {
  sessionId: string; // Session identifier (agent_xxx)
  repository: string; // GitHub repo (owner/repo format)
  mode: string; // Agent mode (code, architect, debug, etc.)
  model: string; // LLM model identifier
};

/**
 * Session start configuration
 * Configuration needed to start a new session
 */
export type SessionStartConfig = {
  githubRepo: string;
  prompt: string;
  mode: 'plan' | 'build';
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

export type StoredSession = {
  sessionId: string;
  repository: string;
  prompt: string;
  mode: string;
  model: string;
  status: 'active' | 'completed' | 'error';
  createdAt: string;
  updatedAt: string;
  /** @deprecated Always empty - use StoredMessage[] from session loading instead */
  messages: LegacySessionMessage[];
  envVars?: Record<string, string>;
  setupCommands?: string[];
  /** Cloud agent session ID - when present, indicates this session ran in cloud */
  cloudAgentSessionId?: string | null;
  /** Platform where session was created: 'cli', 'cloud-agent', 'agent-manager', or extension identifier */
  createdOnPlatform?: string | null;
};

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

/**
 * Zod schema for ToolExecution
 */
export const ToolExecutionSchema = z.object({
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  output: z.string().optional(),
  error: z.string().optional(),
  timestamp: z.string(),
});

// ============================================================================
// Parsed Stream Event Union
// ============================================================================

/**
 * Discriminated union of stream events we handle.
 * These are the typed event payloads after parsing from StreamEventEnvelope.
 */
export type ParsedStreamEvent =
  | { type: 'message.updated'; data: EventMessageUpdated['properties'] }
  | { type: 'message.part.updated'; data: EventMessagePartUpdated['properties'] }
  | { type: 'message.part.removed'; data: EventMessagePartRemoved['properties'] }
  | { type: 'session.status'; data: EventSessionStatus['properties'] }
  | { type: 'session.created'; data: EventSessionCreated['properties'] }
  | { type: 'session.updated'; data: EventSessionUpdated['properties'] }
  | { type: 'session.error'; data: { sessionID?: string; error?: unknown } }
  | { type: 'session.idle'; data: { sessionID: string } };
