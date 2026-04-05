/**
 * WebSocket filter parsing and matching for the /stream endpoint.
 *
 * This module provides utilities for:
 * - Parsing query parameters into StreamFilters
 * - Matching stored events against filters for live broadcast
 */

import type { StreamFilters, StreamEventType, StoredEvent } from './types.js';
import type { ExecutionId, SessionId } from '../types/ids.js';

// ---------------------------------------------------------------------------
// Timestamp Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a timestamp value from query parameter.
 * Supports both integer milliseconds and ISO 8601 format.
 *
 * @param value - The raw query parameter value
 * @returns Unix timestamp in milliseconds, or undefined if invalid
 *
 * @example
 * ```ts
 * parseTimestamp('1705316400000') // → 1705316400000 (integer ms)
 * parseTimestamp('2024-01-15T10:30:00Z') // → 1705316400000 (ISO 8601)
 * parseTimestamp('invalid') // → undefined
 * parseTimestamp(null) // → undefined
 * ```
 */
function parseTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;

  // Try integer milliseconds first
  const parsed = parseInt(value, 10);
  if (!isNaN(parsed)) {
    return parsed;
  }

  // Try ISO 8601 timestamp
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return date.getTime();
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Query Parameter Parsing
// ---------------------------------------------------------------------------

/**
 * Parse query params from /stream URL into StreamFilters.
 *
 * @param url - The request URL containing query parameters
 * @param sessionId - The session ID (extracted from DO context)
 * @returns Parsed stream filters
 *
 * @example
 * ```ts
 * const filters = parseStreamFilters(
 *   new URL('https://example.com/stream?fromId=5&eventTypes=output,error'),
 *   sessionId
 * );
 * // { sessionId, fromId: 5, eventTypes: ['output', 'error'] }
 * ```
 */
export function parseStreamFilters(url: URL, sessionId: SessionId): StreamFilters {
  const filters: StreamFilters = { sessionId };

  const fromIdParam = url.searchParams.get('fromId');
  if (fromIdParam) {
    const parsed = parseInt(fromIdParam, 10);
    if (!isNaN(parsed)) {
      filters.fromId = parsed;
    }
  }

  const executionIdsParam = url.searchParams.get('executionIds');
  if (executionIdsParam) {
    filters.executionIds = executionIdsParam.split(',').filter(Boolean) as ExecutionId[];
  }

  const eventTypesParam = url.searchParams.get('eventTypes');
  if (eventTypesParam) {
    filters.eventTypes = eventTypesParam.split(',').filter(Boolean) as StreamEventType[];
  }

  filters.startTime = parseTimestamp(url.searchParams.get('startTime'));
  filters.endTime = parseTimestamp(url.searchParams.get('endTime'));

  return filters;
}

// ---------------------------------------------------------------------------
// Event Matching
// ---------------------------------------------------------------------------

/**
 * Check if a stored event matches the given filters.
 *
 * Note: This does NOT check `fromId` - that filter is only used for replay queries.
 * Live events are always newer than the client's cursor.
 *
 * @param event - The stored event to check
 * @param filters - The stream filters to match against
 * @returns true if the event matches all applicable filters
 */
export function matchesFilters(event: StoredEvent, filters: StreamFilters): boolean {
  // Check executionIds filter
  if (filters.executionIds && filters.executionIds.length > 0) {
    if (!filters.executionIds.includes(event.execution_id as ExecutionId)) {
      return false;
    }
  }

  // Check eventTypes filter
  if (filters.eventTypes && filters.eventTypes.length > 0) {
    if (!filters.eventTypes.includes(event.stream_event_type as StreamEventType)) {
      return false;
    }
  }

  // Check time range (startTime is inclusive)
  if (filters.startTime !== undefined && event.timestamp < filters.startTime) {
    return false;
  }

  // Check time range (endTime is inclusive)
  if (filters.endTime !== undefined && event.timestamp > filters.endTime) {
    return false;
  }

  return true;
}
