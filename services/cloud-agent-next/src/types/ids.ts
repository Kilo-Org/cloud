/**
 * Type-safe IDs using template literals for the WebSocket streaming feature.
 *
 * These IDs provide compile-time type safety for the various entity
 * identifiers used in the cloud-agent system.
 */

/**
 * Unique identifier for an execution request.
 * Format: exc_<ulid>
 *
 * The exc_ prefix is required for execution correlation.
 */
export type ExecutionId = `exc_${string}`;

/**
 * Union of IDs that can be used as an event source.
 * Lazy-prep collapsed the former `PreparationId` branch, so only execution IDs
 * remain; the alias is kept for callers that still read `EventSourceId`.
 */
export type EventSourceId = ExecutionId;

/**
 * Session identifier - supports:
 * - `sess_*` for new WebSocket sessions
 * - `agent_*` for legacy-plane sessions
 * - `workspace_*` for control-plane sessions
 */
export type SessionId = `sess_${string}` | `agent_${string}` | `workspace_${string}`;

/** User identifier from the authentication system */
export type UserId = string;

/** Auto-incrementing event ID in SQLite storage */
export type EventId = number;
