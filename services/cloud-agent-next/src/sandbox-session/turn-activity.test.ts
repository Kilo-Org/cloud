import { describe, expect, it } from 'vitest';
import type { SessionSyncResult } from '../shared/sandbox-control-protocol.js';
import { acceptedSnapshotKind, isRealTurnActivity } from './turn-activity.js';

describe('isRealTurnActivity', () => {
  it.each(['message.updated', 'message.part.updated', 'message.part.delta'])(
    'treats %s as real progress',
    type => {
      expect(isRealTurnActivity(type, {})).toBe(true);
    }
  );

  it('treats a live busy status event as real progress', () => {
    expect(isRealTurnActivity('session.status', { status: { type: 'busy' } })).toBe(true);
  });

  it.each([
    { name: 'retry', properties: { status: { type: 'retry' } } },
    { name: 'offline', properties: { status: { type: 'offline' } } },
    { name: 'idle', properties: { status: { type: 'idle' } } },
  ])('does not treat $name status as progress', ({ properties }) => {
    expect(isRealTurnActivity('session.status', properties)).toBe(false);
  });

  it.each([
    'question.asked',
    'question.replied',
    'permission.asked',
    'permission.replied',
    'session.error',
    'session.idle',
    'session.turn.close',
    'session.updated',
  ])('does not treat %s as progress', type => {
    expect(isRealTurnActivity(type, {})).toBe(false);
  });

  it('does not treat a string status payload as real progress', () => {
    expect(isRealTurnActivity('session.status', { status: 'busy' })).toBe(false);
  });
});

describe('acceptedSnapshotKind', () => {
  const snapshot = (overrides: Partial<SessionSyncResult>): SessionSyncResult => ({
    status: { type: 'idle' },
    questions: [],
    permissions: [],
    ...overrides,
  });

  it.each(['busy', 'retry', 'offline'])('treats %s snapshots as waiting', type => {
    expect(acceptedSnapshotKind(snapshot({ status: { type } }))).toBe('waiting');
  });

  it('treats pending questions as waiting', () => {
    expect(acceptedSnapshotKind(snapshot({ questions: [{ id: 'question_1' }] }))).toBe('waiting');
  });

  it('treats pending permissions as waiting', () => {
    expect(acceptedSnapshotKind(snapshot({ permissions: [{ id: 'permission_1' }] }))).toBe(
      'waiting'
    );
  });

  it('treats an idle snapshot without pending input as inactive', () => {
    expect(acceptedSnapshotKind(snapshot({ status: { type: 'idle' } }))).toBe('inactive');
  });
});
