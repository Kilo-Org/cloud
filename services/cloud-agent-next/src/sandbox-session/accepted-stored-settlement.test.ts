import { describe, expect, it } from 'vitest';
import type { LatestAssistantMessage } from '../session/types.js';
import type { SessionMessage, SessionMessageIntent } from '../sandbox-state/model/session.js';
import {
  applyStoredAssistantSettlement,
  projectStoredAssistantSettlement,
} from './accepted-stored-settlement.js';

function assistant(
  info: Record<string, unknown>,
  parts: LatestAssistantMessage['parts'] = []
): LatestAssistantMessage {
  return {
    eventId: 1,
    timestamp: 2,
    info: { id: 'ase_1', role: 'assistant', ...info } as LatestAssistantMessage['info'],
    parts,
  };
}

const intent = (messageId: string): SessionMessageIntent => ({
  turn: { type: 'prompt', messageId, prompt: 'hello' },
  agent: { mode: 'build' },
});

function accepted(messageId = 'msg_1'): SessionMessage {
  return {
    messageId,
    state: { kind: 'accepted', intent: intent(messageId), acceptedAt: 5, executionDeadlineAt: 500 },
  };
}

describe('projectStoredAssistantSettlement', () => {
  it('settles a stored assistant answer with a completion marker', () => {
    expect(
      projectStoredAssistantSettlement(assistant({ time: { created: 1, completed: 2 } }))
    ).toEqual({ state: 'completed' });
  });

  it('settles a terminal assistant error with its bounded classification', () => {
    expect(
      projectStoredAssistantSettlement(assistant({ error: 'Provider request timed out' }))
    ).toMatchObject({
      state: 'failed',
      failedReason: 'assistant_error',
      assistantReason: 'timeout',
    });
  });

  it('settles an interrupted assistant error as a cancellation', () => {
    expect(
      projectStoredAssistantSettlement(
        assistant({ error: { name: 'MessageAbortedError', message: 'interrupted' } })
      )
    ).toEqual({ state: 'cancelled', failedReason: 'interrupted' });
  });

  it('does not settle a partial answer with no terminal evidence', () => {
    expect(projectStoredAssistantSettlement(assistant({ time: { created: 1 } }))).toBeUndefined();
    expect(projectStoredAssistantSettlement(null)).toBeUndefined();
  });
});

describe('applyStoredAssistantSettlement', () => {
  it('only settles a record that is still accepted', () => {
    const messages = [accepted()];

    expect(
      applyStoredAssistantSettlement(messages, 'msg_1', { state: 'completed' }, 9)?.[0]
    ).toMatchObject({ state: { kind: 'completed', at: 9, source: 'coordinator' } });
    expect(
      applyStoredAssistantSettlement(messages, 'msg_1', { state: 'completed' }, 9)
    ).toHaveLength(1);
    expect(
      applyStoredAssistantSettlement(
        [
          {
            messageId: 'msg_1',
            state: {
              kind: 'queued',
              intent: intent('msg_1'),
              deliveryStep: 'waiting',
              deadlineAt: null,
              attachFailures: 0,
              promptFailures: 0,
            },
          },
        ],
        'msg_1',
        { state: 'completed' },
        9
      )
    ).toBeUndefined();
    expect(applyStoredAssistantSettlement([], 'msg_1', { state: 'completed' }, 9)).toBeUndefined();
  });

  it('carries the assistant failure facts onto the terminal record', () => {
    const [settled] =
      applyStoredAssistantSettlement(
        [accepted()],
        'msg_1',
        {
          state: 'failed',
          failedReason: 'assistant_error',
          failedDetail: 'Assistant request timed out',
          assistantReason: 'timeout',
          providerOwnership: 'unknown',
        },
        9
      ) ?? [];

    expect(settled).toMatchObject({
      state: {
        kind: 'failed',
        reason: 'assistant_error',
        detail: 'Assistant request timed out',
        assistantReason: 'timeout',
        providerOwnership: 'unknown',
        source: 'coordinator',
      },
    });
  });
});
