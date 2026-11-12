import { describe, expect, it } from 'vitest';
import {
  CHILD_SESSION_CALLBACK_DATA_NOTICE,
  CHILD_SESSION_CALLBACK_INTRO,
  formatChildSessionCallbackPrompt,
  parseChildSessionCallbackPrompt,
  type ChildSessionCallbackPayload,
} from './cloud-agent-child-callback';

const payload: ChildSessionCallbackPayload = {
  version: 1,
  cloudAgentSessionId: 'workspace_2e43e20d-cd4a-4779-b715-d218cffa8f6b',
  kiloSessionId: 'ses_e5c884bceffff2tD0tPYMXMdbi',
  messageId: 'msg_1a37a0bcd000D1kD5ytWNBYC9D',
  status: 'completed',
  branch: 'fix/cloud-environment-selection',
  result: 'PR: https://github.com/Kilo-Org/cloud/pull/9723',
};

describe('child session callback prompt', () => {
  it('round trips the structured payload behind a stable prefix', () => {
    const prompt = formatChildSessionCallbackPrompt(payload);

    expect(
      prompt.startsWith(`${CHILD_SESSION_CALLBACK_INTRO}\n${CHILD_SESSION_CALLBACK_DATA_NOTICE}\n`)
    ).toBe(true);
    expect(parseChildSessionCallbackPrompt(prompt)).toEqual(payload);
  });

  it('reads callbacks written before the version field was added', () => {
    const { version: _version, ...legacy } = payload;
    const prompt = `${CHILD_SESSION_CALLBACK_INTRO}\n${CHILD_SESSION_CALLBACK_DATA_NOTICE}\n${JSON.stringify(
      legacy
    )}`;

    expect(parseChildSessionCallbackPrompt(prompt)).toEqual(payload);
  });

  it('keeps failure details for failed children', () => {
    const failed: ChildSessionCallbackPayload = {
      ...payload,
      status: 'failed',
      errorMessage: 'The command failed',
      failure: { code: 'workspace_setup_failed', subtype: 'setup_command_failed' },
    };

    expect(parseChildSessionCallbackPrompt(formatChildSessionCallbackPrompt(failed))).toEqual(
      failed
    );
  });

  it('rejects ordinary prompts, malformed JSON, and unknown payload fields', () => {
    const unknownField = `${CHILD_SESSION_CALLBACK_INTRO}\n${CHILD_SESSION_CALLBACK_DATA_NOTICE}\n${JSON.stringify(
      { ...payload, unexpected: true }
    )}`;

    expect(parseChildSessionCallbackPrompt('Please inspect this file.')).toBeNull();
    expect(
      parseChildSessionCallbackPrompt(
        `${CHILD_SESSION_CALLBACK_INTRO}\n${CHILD_SESSION_CALLBACK_DATA_NOTICE}\n{`
      )
    ).toBeNull();
    expect(parseChildSessionCallbackPrompt(unknownField)).toBeNull();
    expect(
      parseChildSessionCallbackPrompt(formatChildSessionCallbackPrompt(payload))
    ).not.toBeNull();
  });
});
