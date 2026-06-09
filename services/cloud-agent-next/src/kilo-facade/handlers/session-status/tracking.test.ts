import { describe, expect, it } from 'vitest';
import { publicSessionStatusesFromAttachments, sessionStatusUpdateFromEvent } from './tracking.js';

const rootSessionId = 'ses_12345678901234567890123456';

describe('session status tracking', () => {
  it('keeps the latest producer generation and only exposes non-idle root statuses', () => {
    expect(
      publicSessionStatusesFromAttachments([
        { kiloSessionId: rootSessionId, wrapperGeneration: 1, sessionStatus: { type: 'busy' } },
        { kiloSessionId: rootSessionId, wrapperGeneration: 2 },
        {
          kiloSessionId: 'ses_22222222222222222222222222',
          wrapperGeneration: 1,
          sessionStatus: { type: 'offline', requestID: 'request-1', message: 'Waiting' },
        },
      ])
    ).toEqual({
      ses_22222222222222222222222222: {
        type: 'offline',
        requestID: 'request-1',
        message: 'Waiting',
      },
    });
  });

  it('accepts the current SDK retry action shape and clears idle', () => {
    expect(
      sessionStatusUpdateFromEvent(
        {
          type: 'session.status',
          properties: {
            sessionID: rootSessionId,
            status: {
              type: 'retry',
              attempt: 1,
              message: 'Retrying',
              action: {
                reason: 'rate_limit',
                provider: 'kilo',
                title: 'Try again',
                message: 'Waiting',
                label: 'Retry',
                link: 'https://example.com/retry',
              },
              next: 123,
            },
          },
        },
        rootSessionId
      )
    ).toEqual({
      kind: 'set',
      status: {
        type: 'retry',
        attempt: 1,
        message: 'Retrying',
        action: {
          reason: 'rate_limit',
          provider: 'kilo',
          title: 'Try again',
          message: 'Waiting',
          label: 'Retry',
          link: 'https://example.com/retry',
        },
        next: 123,
      },
    });
    expect(
      sessionStatusUpdateFromEvent(
        {
          type: 'session.status',
          properties: { sessionID: rootSessionId, status: { type: 'idle' } },
        },
        rootSessionId
      )
    ).toEqual({ kind: 'clear' });
    expect(
      sessionStatusUpdateFromEvent(
        { type: 'session.idle', properties: { sessionID: rootSessionId } },
        rootSessionId
      )
    ).toEqual({ kind: 'clear' });
  });
});
