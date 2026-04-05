/**
 * Cloud Agent Types
 *
 * Type definitions for cloud agent chat messages and related structures.
 * These mostly mimic the CLI's message format.
 *
 * IMPORTANT: This file should NOT import from other cloud-agent modules
 * to avoid circular dependencies. It serves as the base types file.
 */

import * as z from 'zod';
import type { Images } from '@/lib/images-schema';

// ============================================================================
// Agent Mode Types
// ============================================================================

/**
 * Valid mode values for cloud agent sessions.
 * Matches agentModeSchema in cloud-agent-schemas.ts
 */
export type AgentMode = 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';

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
// Streaming Message Types (for Jotai state management)
// ============================================================================

/**
 * Cloud agent message
 * Represents all types of messages in the chat (user, assistant, system)
 * Used for streaming state with Jotai atoms
 */
export interface CloudMessage {
  ts: number; // Timestamp (unique ID for message)
  type: 'user' | 'assistant' | 'system'; // Message role
  say?: string; // Say subtype (text, completion_result, api_req_started, etc.)
  ask?: string; // Ask subtype (tool, command, use_mcp_tool, etc.)
  text?: string; // Message content
  content?: string; // Alternative content field (stream uses both)
  partial?: boolean; // Streaming status (true = still streaming)
  metadata?: Record<string, unknown>; // Additional metadata from stream
  toolExecutions?: ToolExecution[]; // Attached tool executions (for completion messages)
  images?: Images; // Image attachments for the message
}

// ============================================================================
// Stored Session Message Types (for localStorage)
// ============================================================================

/**
 * Message role type
 */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Base message interface with common fields
 */
export interface BaseMessage {
  role: MessageRole;
  timestamp: string;
}

/**
 * User message
 */
export interface UserMessage extends BaseMessage {
  role: 'user';
  content: string;
}

/**
 * Assistant message
 */
export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  content: string;
  toolExecutions?: ToolExecution[];
}

/**
 * System message
 */
export interface SystemMessage extends BaseMessage {
  role: 'system';
  content: string;
}

/**
 * Union type for all message types
 */
export type Message = UserMessage | AssistantMessage | SystemMessage;

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Tool execution
 * Represents a tool/command that was executed during the session
 */
export interface ToolExecution {
  toolName: string; // Tool identifier (bash, read, edit, etc.)
  input: Record<string, unknown>; // Tool input parameters
  output?: string; // Tool output (when complete)
  error?: string; // Error message (if failed)
  timestamp: string; // ISO timestamp
}

/**
 * Session configuration
 * Stores the current session's configuration
 */
export interface SessionConfig {
  sessionId: string; // Session identifier (agent_xxx)
  repository: string; // GitHub repo (owner/repo format)
  mode: string; // Agent mode (code, architect, debug, etc.)
  model: string; // LLM model identifier
}

/**
 * Session start configuration
 * Configuration needed to start a new session
 */
export interface SessionStartConfig {
  githubRepo: string;
  prompt: string;
  mode: 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';
  model: string;
  githubToken?: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
  upstreamBranch?: string;
}

/**
 * Stored session interface
 * Used for localStorage persistence
 */
export interface StoredSession {
  sessionId: string;
  repository: string;
  prompt: string;
  mode: string;
  model: string;
  status: 'active' | 'completed' | 'error';
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  envVars?: Record<string, string>;
  setupCommands?: string[];
  /** Cloud agent session ID - when present, indicates this session ran in cloud */
  cloudAgentSessionId?: string | null;
  /** Platform where session was created: 'cli', 'cloud-agent', 'agent-manager', or extension identifier */
  createdOnPlatform?: string | null;
}

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

/**
 * Zod schema for Message (discriminated union)
 */
export const MessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('user'),
    content: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    timestamp: z.string(),
    toolExecutions: z.array(ToolExecutionSchema).optional(),
  }),
  z.object({
    role: z.literal('system'),
    content: z.string(),
    timestamp: z.string(),
  }),
]);

/**
 * Zod schema for StoredSession
 */
export const StoredSessionSchema = z.object({
  sessionId: z.string(),
  repository: z.string(),
  prompt: z.string(),
  mode: z.string(),
  model: z.string(),
  status: z.enum(['active', 'completed', 'error']),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(MessageSchema),
  envVars: z.record(z.string(), z.string()).optional(),
  setupCommands: z.array(z.string()).optional(),
  cloudAgentSessionId: z.string().nullish(),
});

/**
 * Zod schema for array of StoredSessions
 */
export const StoredSessionsArraySchema = z.array(StoredSessionSchema);

// ============================================================================
// Streaming Event Types (from cloud-agent)
// ============================================================================

/**
 * Raw Kilocode CLI event - preserved exactly as received from stdout JSON.
 * These events come directly from the Kilocode CLI and may contain any fields.
 */
export type KilocodeEvent = Record<string, unknown>;

/**
 * System events use streamEventType discriminator to avoid collision with Kilocode's type field.
 * These are internal events generated by the streaming infrastructure.
 */
export type SystemStatusEvent = {
  streamEventType: 'status';
  message: string;
  timestamp: string;
  sessionId?: string;
};

export type SystemOutputEvent = {
  streamEventType: 'output';
  content: string;
  source: 'stdout' | 'stderr';
  timestamp: string;
  sessionId?: string;
};

export type SystemErrorEvent = {
  streamEventType: 'error';
  error: string;
  details?: unknown;
  timestamp: string;
  sessionId?: string;
};

export type SystemCompleteEvent = {
  streamEventType: 'complete';
  sessionId: string;
  exitCode: number;
  metadata: {
    executionTimeMs: number;
    workspace: string;
    userId: string;
    startedAt: string;
    completedAt: string;
  };
};

export type SystemKilocodeEvent = {
  streamEventType: 'kilocode';
  payload: KilocodeEvent;
  sessionId?: string;
};

export type SystemInterruptedEvent = {
  streamEventType: 'interrupted';
  reason: string;
  timestamp: string;
  sessionId?: string;
};

/**
 * Union of all streaming event types.
 * All events now use streamEventType discriminator - Kilocode CLI events are wrapped in SystemKilocodeEvent.
 */
export type StreamEvent =
  | SystemKilocodeEvent
  | SystemStatusEvent
  | SystemOutputEvent
  | SystemErrorEvent
  | SystemCompleteEvent
  | SystemInterruptedEvent;
