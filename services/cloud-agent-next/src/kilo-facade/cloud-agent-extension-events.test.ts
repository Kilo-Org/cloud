import { describe, expect, it } from 'vitest';
import { projectPublicCloudAgentExtensionEvent } from './cloud-agent-extension-events';

const kiloSessionId = 'ses_12345678901234567890123456';

function source(streamEventType: string, payload: unknown) {
  return { stream_event_type: streamEventType, payload: JSON.stringify(payload) };
}

describe('projectPublicCloudAgentExtensionEvent', () => {
  it('projects durable message lifecycle events without prompt or diagnostic data', () => {
    expect(
      projectPublicCloudAgentExtensionEvent(
        source('cloud.message.queued', {
          messageId: 'msg_queued',
          content: 'secret prompt',
          delivery: 'queued',
        }),
        kiloSessionId
      )
    ).toEqual({
      type: 'cloud.message.queued',
      properties: { sessionID: kiloSessionId, messageId: 'msg_queued', delivery: 'queued' },
    });
    expect(
      projectPublicCloudAgentExtensionEvent(
        source('cloud.message.sent', { messageId: 'msg_sent', delivery: 'sent' }),
        kiloSessionId
      )
    ).toEqual({
      type: 'cloud.message.sent',
      properties: { sessionID: kiloSessionId, messageId: 'msg_sent', delivery: 'sent' },
    });
    expect(
      projectPublicCloudAgentExtensionEvent(
        source('cloud.message.completed', {
          messageId: 'msg_completed',
          status: 'completed',
          delivery: 'sent',
          accepted: true,
          assistantMessageId: 'msg_private_assistant',
        }),
        kiloSessionId
      )
    ).toEqual({
      type: 'cloud.message.completed',
      properties: {
        sessionID: kiloSessionId,
        messageId: 'msg_completed',
        status: 'completed',
        delivery: 'sent',
        accepted: true,
      },
    });
    expect(
      projectPublicCloudAgentExtensionEvent(
        source('cloud.message.failed', {
          messageId: 'msg_failed',
          status: 'failed',
          delivery: 'queued',
          accepted: false,
          error: '/workspace/private/token failure',
          attempts: 3,
        }),
        kiloSessionId
      )
    ).toEqual({
      type: 'cloud.message.failed',
      properties: {
        sessionID: kiloSessionId,
        messageId: 'msg_failed',
        status: 'failed',
        delivery: 'queued',
        accepted: false,
      },
    });
  });

  it('projects only public cloud status vocabulary and drops arbitrary progress messages', () => {
    expect(
      projectPublicCloudAgentExtensionEvent(
        source('cloud.status', {
          cloudStatus: {
            type: 'preparing',
            step: 'kilo_session',
            message: 'Restoring /workspace/private/session',
          },
        }),
        kiloSessionId
      )
    ).toEqual({
      type: 'cloud.status',
      properties: {
        sessionID: kiloSessionId,
        cloudStatus: { type: 'preparing', step: 'kilo_session' },
      },
    });
    expect(
      projectPublicCloudAgentExtensionEvent(
        source('cloud.status', {
          cloudStatus: { type: 'preparing', step: 'private_step', message: 'secret' },
        }),
        kiloSessionId
      )
    ).toEqual({
      type: 'cloud.status',
      properties: { sessionID: kiloSessionId, cloudStatus: { type: 'preparing' } },
    });
  });

  it('drops unselected or malformed source events', () => {
    expect(
      projectPublicCloudAgentExtensionEvent(
        source('preparing', { step: 'kilo_session' }),
        kiloSessionId
      )
    ).toBeNull();
    expect(
      projectPublicCloudAgentExtensionEvent(
        source('cloud.message.queued', { content: 'missing id' }),
        kiloSessionId
      )
    ).toBeNull();
    expect(
      projectPublicCloudAgentExtensionEvent(
        { stream_event_type: 'cloud.status', payload: '{malformed' },
        kiloSessionId
      )
    ).toBeNull();
  });
});
