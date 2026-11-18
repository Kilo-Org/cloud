import { describe, expect, it } from 'vitest';

import {
  type AssistantMessage,
  type Part,
  type StepFinishPart,
  type StoredMessage,
  type UserMessage,
} from '@kilocode/cloud-agent-sdk';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { getChildSessionModelLabel } from './child-session-model';

/**
 * Child-session model label resolution.
 *
 * Contract:
 *  - scans from the last message to the first
 *  - the last assistant message with resolvable model data wins
 *  - returns null for empty transcripts, user-only transcripts, and legacy
 *    blank provider/model fields
 *  - prefers the routed model on the last step-finish part over info-level
 *    provider/model
 *  - falls back to a date-suffix-stripped raw modelID for unknown models
 */

const catalogOption: SessionModelOption = {
  id: 'anthropic/claude-sonnet-4',
  name: 'Claude Sonnet 4',
  displayId: 'claude-sonnet-4',
  variants: [],
  isPreferred: false,
  showGatewayMetadata: false,
  provider: { id: 'anthropic', name: 'Anthropic' },
  modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
};

function assistantInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'msg-1',
    sessionID: 'ses-1',
    role: 'assistant',
    time: { created: 1 },
    parentID: 'msg-0',
    modelID: 'claude-sonnet-4',
    providerID: 'anthropic',
    mode: 'code',
    agent: 'test',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function userInfo(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'u-1',
    sessionID: 'ses-1',
    role: 'user',
    time: { created: 1 },
    agent: 'test',
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
    ...overrides,
  };
}

function stepFinish(overrides: Partial<StepFinishPart> = {}): StepFinishPart {
  return {
    id: 'p-finish',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'step-finish',
    reason: 'stop',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function storedMessage(info: AssistantMessage | UserMessage, parts: Part[] = []): StoredMessage {
  return { info, parts };
}

// The `model` field is present on the wire and in the Zod contract but
// absent from the generated `StepFinishPart` type, so we cast — same
// pattern as `message-model-label.test.ts` and `part-utils.test.ts`.
function stepFinishWithRouted(
  routed: { providerID: string; modelID: string },
  overrides: Partial<StepFinishPart> = {}
): StepFinishPart {
  return Object.assign(stepFinish(overrides), { model: routed }) as StepFinishPart;
}

describe('getChildSessionModelLabel', () => {
  it('returns null for an empty transcript', () => {
    expect(getChildSessionModelLabel([], [catalogOption])).toBeNull();
  });

  it('returns null for a user-only transcript', () => {
    const messages = [storedMessage(userInfo())];
    expect(getChildSessionModelLabel(messages, [catalogOption])).toBeNull();
  });

  it('returns the catalog name when info matches a catalog option', () => {
    const messages = [storedMessage(assistantInfo())];
    expect(getChildSessionModelLabel(messages, [catalogOption])).toBe('Claude Sonnet 4');
  });

  it('strips a trailing date suffix for an unknown model', () => {
    const messages = [
      storedMessage(assistantInfo({ providerID: 'kilo', modelID: 'claude-sonnet-4-20260101' })),
    ];
    expect(getChildSessionModelLabel(messages, [catalogOption])).toBe('claude-sonnet-4');
  });

  it('returns null for legacy blank providerID/modelID', () => {
    const messages = [storedMessage(assistantInfo({ providerID: '', modelID: '' }))];
    expect(getChildSessionModelLabel(messages, [catalogOption])).toBeNull();
  });

  it('prefers the routed model on the last step-finish part', () => {
    const info = assistantInfo({
      id: 'm1',
      providerID: 'kilo',
      modelID: 'kilo-auto/efficient',
    });
    const finish = stepFinishWithRouted(
      { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      { id: 'sf-1' }
    );
    const messages = [storedMessage(info, [finish])];
    expect(getChildSessionModelLabel(messages, [catalogOption])).toBe('Claude Sonnet 4');
  });

  it('lets the last assistant message with model data win', () => {
    const first = storedMessage(
      assistantInfo({ id: 'm1', providerID: 'openai', modelID: 'gpt-4o' })
    );
    const second = storedMessage(
      assistantInfo({ id: 'm2', providerID: 'anthropic', modelID: 'claude-sonnet-4' })
    );
    expect(getChildSessionModelLabel([first, second], [catalogOption])).toBe('Claude Sonnet 4');
  });
});
