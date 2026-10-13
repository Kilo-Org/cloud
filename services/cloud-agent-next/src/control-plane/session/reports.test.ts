import { describe, expect, it } from 'vitest';
import type { SessionMessage } from './messages.js';
import { projectSettledMessageFailure } from './reports.js';
import { classifyAssistantFailure } from '../../shared/assistant-failure.js';

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
  it.each([400, 402, 403])(
    'preserves classified BYOK APIError %s facts in the callback projection',
    statusCode => {
      const classified = classifyAssistantFailure({
        name: 'APIError',
        data: { statusCode, responseBody: '{"error_type":"byok_error","message":"poison-body"}' },
      });
      const failure = projectSettledMessageFailure(
        message({ state: 'failed', acceptedAt: 1, reason: classified.safeMessage }),
        { assistantReason: classified.reason, providerOwnership: classified.providerOwnership }
      );

      expect(failure).toMatchObject({
        stage: 'agent_activity',
        code: classified.terminalCode ?? 'assistant_error',
        assistantReason: classified.reason,
        providerOwnership: 'byok',
      });
      expect(JSON.stringify(failure)).not.toContain('poison');
    }
  );

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
