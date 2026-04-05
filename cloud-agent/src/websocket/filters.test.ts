import { describe, it, expect } from 'vitest';
import { parseStreamFilters, matchesFilters } from './filters.js';
import type { StoredEvent, StreamFilters } from './types.js';
import type { SessionId, ExecutionId, EventId } from '../types/ids.js';

describe('WebSocket Filters', () => {
  describe('parseStreamFilters', () => {
    const sessionId = 'sess_123' as SessionId;

    it('should parse empty URL with just sessionId', () => {
      const url = new URL('https://example.com/stream');
      const filters = parseStreamFilters(url, sessionId);

      expect(filters.sessionId).toBe(sessionId);
      expect(filters.fromId).toBeUndefined();
      expect(filters.executionIds).toBeUndefined();
      expect(filters.eventTypes).toBeUndefined();
      expect(filters.startTime).toBeUndefined();
      expect(filters.endTime).toBeUndefined();
    });

    it('should parse fromId as number', () => {
      const url = new URL('https://example.com/stream?fromId=123');
      const filters = parseStreamFilters(url, sessionId);

      expect(filters.fromId).toBe(123);
    });

    it('should ignore non-numeric fromId', () => {
      const url = new URL('https://example.com/stream?fromId=abc');
      const filters = parseStreamFilters(url, sessionId);

      expect(filters.fromId).toBeUndefined();
    });

    it('should parse executionIds as comma-separated list', () => {
      const url = new URL('https://example.com/stream?executionIds=exec_1,exec_2,exec_3');
      const filters = parseStreamFilters(url, sessionId);

      expect(filters.executionIds).toEqual(['exec_1', 'exec_2', 'exec_3']);
    });

    it('should parse eventTypes as comma-separated list', () => {
      const url = new URL('https://example.com/stream?eventTypes=output,error,complete');
      const filters = parseStreamFilters(url, sessionId);

      expect(filters.eventTypes).toEqual(['output', 'error', 'complete']);
    });

    it('should parse startTime and endTime as numbers', () => {
      const url = new URL('https://example.com/stream?startTime=1000&endTime=2000');
      const filters = parseStreamFilters(url, sessionId);

      expect(filters.startTime).toBe(1000);
      expect(filters.endTime).toBe(2000);
    });

    it('should parse all filters together', () => {
      const url = new URL(
        'https://example.com/stream?fromId=100&executionIds=exec_1,exec_2&eventTypes=output&startTime=1000&endTime=2000'
      );
      const filters = parseStreamFilters(url, sessionId);

      expect(filters).toEqual({
        sessionId,
        fromId: 100,
        executionIds: ['exec_1', 'exec_2'],
        eventTypes: ['output'],
        startTime: 1000,
        endTime: 2000,
      });
    });
  });

  describe('matchesFilters', () => {
    const createEvent = (overrides?: Partial<StoredEvent>): StoredEvent => ({
      id: 1 as EventId,
      execution_id: 'exec_1',
      session_id: 'sess_1',
      stream_event_type: 'output',
      payload: '{}',
      timestamp: 1500,
      ...overrides,
    });

    const createFilters = (overrides?: Partial<StreamFilters>): StreamFilters => ({
      sessionId: 'sess_1' as SessionId,
      ...overrides,
    });

    it('should match when no filters specified', () => {
      const event = createEvent();
      const filters = createFilters();

      expect(matchesFilters(event, filters)).toBe(true);
    });

    it('should match when executionId is in executionIds list', () => {
      const event = createEvent({ execution_id: 'exec_2' });
      const filters = createFilters({ executionIds: ['exec_1', 'exec_2'] as ExecutionId[] });

      expect(matchesFilters(event, filters)).toBe(true);
    });

    it('should not match when executionId is not in executionIds list', () => {
      const event = createEvent({ execution_id: 'exec_3' });
      const filters = createFilters({ executionIds: ['exec_1', 'exec_2'] as ExecutionId[] });

      expect(matchesFilters(event, filters)).toBe(false);
    });

    it('should match when eventType is in eventTypes list', () => {
      const event = createEvent({ stream_event_type: 'error' });
      const filters = createFilters({ eventTypes: ['output', 'error'] });

      expect(matchesFilters(event, filters)).toBe(true);
    });

    it('should not match when eventType is not in eventTypes list', () => {
      const event = createEvent({ stream_event_type: 'complete' });
      const filters = createFilters({ eventTypes: ['output', 'error'] });

      expect(matchesFilters(event, filters)).toBe(false);
    });

    it('should match when timestamp >= startTime (inclusive)', () => {
      const event = createEvent({ timestamp: 1000 });
      const filters = createFilters({ startTime: 1000 });

      expect(matchesFilters(event, filters)).toBe(true);
    });

    it('should not match when timestamp < startTime', () => {
      const event = createEvent({ timestamp: 999 });
      const filters = createFilters({ startTime: 1000 });

      expect(matchesFilters(event, filters)).toBe(false);
    });

    it('should match when timestamp <= endTime (inclusive)', () => {
      const event = createEvent({ timestamp: 2000 });
      const filters = createFilters({ endTime: 2000 });

      expect(matchesFilters(event, filters)).toBe(true);
    });

    it('should not match when timestamp > endTime', () => {
      const event = createEvent({ timestamp: 2001 });
      const filters = createFilters({ endTime: 2000 });

      expect(matchesFilters(event, filters)).toBe(false);
    });

    it('should require all filters to match (AND logic)', () => {
      const event = createEvent({
        execution_id: 'exec_1',
        stream_event_type: 'output',
        timestamp: 1500,
      });

      const filters = createFilters({
        executionIds: ['exec_1'] as ExecutionId[],
        eventTypes: ['output'],
        startTime: 1000,
        endTime: 2000,
      });

      expect(matchesFilters(event, filters)).toBe(true);
    });

    it('should not match if any filter fails', () => {
      const event = createEvent({
        execution_id: 'exec_1',
        stream_event_type: 'error', // Wrong type
        timestamp: 1500,
      });

      const filters = createFilters({
        executionIds: ['exec_1'] as ExecutionId[],
        eventTypes: ['output'], // Requires 'output' but event is 'error'
        startTime: 1000,
        endTime: 2000,
      });

      expect(matchesFilters(event, filters)).toBe(false);
    });
  });
});
