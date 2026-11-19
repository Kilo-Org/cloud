import { describe, expect, it } from 'vitest';

import { sessionLiveActivityContentStateSchema } from './session-live-content';

const validState = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'session-1',
  title: 'Fix the login bug',
  statusKind: 'needsInput',
  statusSince: '2026-11-12T09:00:00.000Z',
  scheduledAt: null,
  awaitingPermission: false,
  approvalKey: null,
  updatedAt: '2026-11-12T09:01:00.000Z',
  ...overrides,
});

const ISO_Z = ['2026-10-12T10:00:00.000Z', '2026-10-12T10:00:00Z'];
const NOT_ISO = ['2026-10-12', '2026-10-12 10:00:00+00', '2026-10-12T10:00:00+02:00', 'not-a-time'];

const TIMESTAMP_FIELDS = [
  'statusSince',
  'scheduledAt',
  'updatedAt',
  'lastActivityAt',
  'startedAt',
] as const;

describe('sessionLiveActivityContentStateSchema timestamps', () => {
  it('parses a state carrying only the required fields', () => {
    expect(sessionLiveActivityContentStateSchema.safeParse(validState()).success).toBe(true);
  });

  it.each(TIMESTAMP_FIELDS)('accepts an ISO Z value with and without millis in %s', field => {
    for (const value of ISO_Z) {
      const state = validState({ [field]: value });
      expect(sessionLiveActivityContentStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it.each(TIMESTAMP_FIELDS)('rejects a non-ISO value in %s', field => {
    for (const value of NOT_ISO) {
      const state = validState({ [field]: value });
      expect(sessionLiveActivityContentStateSchema.safeParse(state).success).toBe(false);
    }
  });

  it.each(['scheduledAt', 'lastActivityAt', 'startedAt'])('accepts null in %s', field => {
    const state = validState({ [field]: null });
    expect(sessionLiveActivityContentStateSchema.safeParse(state).success).toBe(true);
  });

  it.each(['lastActivityAt', 'startedAt'])('accepts an omitted %s', field => {
    const state: Record<string, unknown> = validState();
    delete state[field];
    expect(sessionLiveActivityContentStateSchema.safeParse(state).success).toBe(true);
  });

  it.each(['statusSince', 'updatedAt'])('still requires %s and rejects null there', field => {
    const omitted: Record<string, unknown> = validState();
    delete omitted[field];
    expect(sessionLiveActivityContentStateSchema.safeParse(omitted).success).toBe(false);
    expect(
      sessionLiveActivityContentStateSchema.safeParse(validState({ [field]: null })).success
    ).toBe(false);
  });
});
