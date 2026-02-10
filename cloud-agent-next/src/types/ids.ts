/**
 * Type-safe IDs using template literals for the WebSocket streaming feature.
 *
 * These IDs provide compile-time type safety and runtime validation
 * for the various entity identifiers used in the cloud-agent system.
 */

import { ulid } from 'ulid';

/**
 * Unique identifier for an execution request.
 * Format: exc_<ulid>
 *
 * The exc_ prefix is required for execution correlation.
 */
export type ExecutionId = `exc_${string}`;

/**
 * Session identifier - supports both:
 * - `sess_*` for new WebSocket sessions
 * - `agent_*` for backward compatibility with existing session format
 */
export type SessionId = `sess_${string}` | `agent_${string}`;

/** Unique identifier for an execution lease */
export type LeaseId = `lease_${string}`;

/** User identifier from the authentication system */
export type UserId = `user_${string}`;

/** Auto-incrementing event ID in SQLite storage */
export type EventId = number;

// ---------------------------------------------------------------------------
// ID Generators
// ---------------------------------------------------------------------------

/** Generate a new unique execution ID (exc_<ulid> format for execution tracking) */
export const createExecutionId = (): ExecutionId => `exc_${ulid()}`;

/** Generate a new unique lease ID */
export const createLeaseId = (): LeaseId => `lease_${crypto.randomUUID()}`;

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/** Check if a string is a valid ExecutionId (exc_<ulid> format) */
export const isExecutionId = (s: string): s is ExecutionId => s.startsWith('exc_');

/** Check if a string is a valid SessionId (supports both sess_ and agent_ prefixes) */
export const isSessionId = (s: string): s is SessionId =>
  s.startsWith('sess_') || s.startsWith('agent_');

/** Check if a string is a valid LeaseId */
export const isLeaseId = (s: string): s is LeaseId => s.startsWith('lease_');
