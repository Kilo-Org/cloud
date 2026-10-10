import { describe, expect, it } from 'vitest';
import type { SessionMessage } from './messages.js';
import { projectSettledMessageFailure } from './reports.js';

function message(
  overrides: Partial<SessionMessage> & Pick<SessionMessage, 'state'>
): SessionMessage {
  return {
    messageId: 'm1',
    intent: {
      messageId: 'm1',
      turn: { type: 'prompt', prompt: 'review this' },
      agent: { mode: 'code', model: 'test/model' },
    } as SessionMessage['intent'],
    createdAt: 1,
    acceptedAt: null,
    settledAt: 2,
    reason: null,
    ...overrides,
  };
}

describe('projectSettledMessageFailure', () => {
  it('projects a workspace clone timeout subtype onto the callback failure', () => {
    const failure = projectSettledMessageFailure(
      message({ state: 'failed', reason: 'workspace_setup_failed' }),
      { workspaceSubtype: 'git_clone_timeout' }
    );

    expect(failure).toMatchObject({
      stage: 'pre_dispatch',
      code: 'workspace_setup_failed',
      subtype: 'git_clone_timeout',
      message: 'Repository clone timed out',
    });
  });

  it('projects a plain pre-dispatch failure without a subtype', () => {
    const failure = projectSettledMessageFailure(
      message({ state: 'failed', reason: 'preparation_timeout' }),
      {}
    );

    expect(failure).toMatchObject({ stage: 'pre_dispatch', code: 'wrapper_start_failed' });
    expect(failure?.subtype).toBeUndefined();
  });

  it('returns undefined for a non-terminal message', () => {
    expect(projectSettledMessageFailure(message({ state: 'queued' }), {})).toBeUndefined();
    expect(projectSettledMessageFailure(message({ state: 'accepted' }), {})).toBeUndefined();
  });
});
