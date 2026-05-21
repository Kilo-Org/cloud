import { isValidCloudAgentEvent, isStreamError } from './event-types';

function validBaseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 1,
    sessionId: 'ses-1',
    streamEventType: 'status',
    timestamp: new Date().toISOString(),
    data: {},
    ...overrides,
  };
}

describe('isValidCloudAgentEvent', () => {
  it('accepts an event with executionId as a string', () => {
    const event = validBaseEvent({ executionId: 'exec-1' });
    expect(isValidCloudAgentEvent(event)).toBe(true);
  });

  it('accepts an event without executionId', () => {
    const event = validBaseEvent();
    expect(isValidCloudAgentEvent(event)).toBe(true);
  });

  it('accepts an event with executionId as null', () => {
    const event = validBaseEvent({ executionId: null });
    expect(isValidCloudAgentEvent(event)).toBe(true);
  });

  it('rejects an event with executionId as a number', () => {
    const event = validBaseEvent({ executionId: 42 });
    expect(isValidCloudAgentEvent(event)).toBe(false);
  });

  it('rejects an event missing eventId', () => {
    const { eventId, ...event } = validBaseEvent({ executionId: 'exec-1' });
    void eventId;
    expect(isValidCloudAgentEvent(event)).toBe(false);
  });

  it('rejects an event missing sessionId', () => {
    const { sessionId, ...event } = validBaseEvent({ executionId: 'exec-1' });
    void sessionId;
    expect(isValidCloudAgentEvent(event)).toBe(false);
  });
});

describe('isStreamError', () => {
  it('accepts a valid stream error', () => {
    expect(isStreamError({ type: 'error', code: 'WS_AUTH_ERROR', message: 'bad' })).toBe(true);
  });

  it('rejects an invalid code', () => {
    expect(isStreamError({ type: 'error', code: 'INVALID', message: 'bad' })).toBe(false);
  });
});
