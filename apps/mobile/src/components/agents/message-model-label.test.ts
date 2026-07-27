import { describe, expect, it } from 'vitest';

import {
  type AssistantMessage,
  type Part,
  type StepFinishPart,
  type StoredMessage,
  type UserMessage,
} from 'cloud-agent-sdk';

import { resolveMessageDisplayModel } from './message-model-label';

/**
 * Routed-first model resolution for assistant messages (message details sheet).
 *
 * Contract:
 *  - prefers the LAST routed-model step-finish part over info.providerID/modelID
 *  - falls back to info when no routed part is present
 *  - returns null for user messages and when no model info is resolvable
 */

function assistantInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'msg-1',
    sessionID: 'ses-1',
    role: 'assistant',
    time: { created: 1 },
    parentID: 'msg-0',
    modelID: 'claude-sonnet-4',
    providerID: 'kilo',
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
    model: { providerID: 'kilo', modelID: 'claude-sonnet-4' },
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
// pattern as `session-cost-breakdown.test.ts` and `part-utils.test.ts`.
function stepFinishWithRouted(
  routed: { providerID: string; modelID: string },
  overrides: Partial<StepFinishPart> = {}
): StepFinishPart {
  return Object.assign(stepFinish(overrides), { model: routed }) as StepFinishPart;
}

describe('resolveMessageDisplayModel', () => {
  it('returns null for a user message', () => {
    const message = storedMessage(userInfo());
    expect(resolveMessageDisplayModel(message)).toBeNull();
  });

  it('prefers the LAST routed step-finish model over info.modelID/info.providerID', () => {
    const info = assistantInfo({
      id: 'm1',
      providerID: 'kilo',
      modelID: 'kilo-auto/efficient',
    });
    const first = stepFinishWithRouted(
      { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      { id: 'sf-1' }
    );
    const second = stepFinishWithRouted(
      { providerID: 'openai', modelID: 'gpt-4o' },
      { id: 'sf-2' }
    );
    const message = storedMessage(info, [first, second]);
    expect(resolveMessageDisplayModel(message)).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o',
    });
  });

  it('falls back to info.providerID / info.modelID when no routed part is present', () => {
    const info = assistantInfo({ providerID: 'kilo', modelID: 'kilo-auto/efficient' });
    const textPart: Part = {
      id: 'p-text',
      sessionID: 'ses-1',
      messageID: 'msg-1',
      type: 'text',
      text: 'hi',
    };
    const message = storedMessage(info, [textPart]);
    expect(resolveMessageDisplayModel(message)).toEqual({
      providerID: 'kilo',
      modelID: 'kilo-auto/efficient',
    });
  });

  it('falls back to info even when a step-finish part is present but has no routed model', () => {
    const info = assistantInfo({ providerID: 'kilo', modelID: 'kilo-auto/efficient' });
    const bareFinish = stepFinish({ id: 'sf-1' });
    const message = storedMessage(info, [bareFinish]);
    expect(resolveMessageDisplayModel(message)).toEqual({
      providerID: 'kilo',
      modelID: 'kilo-auto/efficient',
    });
  });

  it('returns null when no routed part is present and info.modelID/info.providerID are missing', () => {
    // No step-finish part; info.providerID is empty.
    const info: AssistantMessage = { ...assistantInfo(), providerID: '' };
    const message = storedMessage(info);
    expect(resolveMessageDisplayModel(message)).toBeNull();
  });

  it('returns null when info.providerID is empty even with a valid info.modelID', () => {
    const info = assistantInfo({ providerID: '', modelID: 'claude-sonnet-4' });
    const message = storedMessage(info);
    expect(resolveMessageDisplayModel(message)).toBeNull();
  });

  it('returns null when info.modelID is empty even with a valid info.providerID', () => {
    const info = assistantInfo({ providerID: 'kilo', modelID: '' });
    const message = storedMessage(info);
    expect(resolveMessageDisplayModel(message)).toBeNull();
  });
});
