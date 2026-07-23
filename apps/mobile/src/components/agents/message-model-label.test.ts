import { describe, expect, it } from 'vitest';

import {
  type AssistantMessage,
  type Part,
  type StepFinishPart,
  type StoredMessage,
  type UserMessage,
} from 'cloud-agent-sdk';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { computeMessageModelLabels, resolveMessageDisplayModel } from './message-model-label';

/**
 * F3 — per-message model label helpers.
 *
 * Contract:
 *  - `resolveMessageDisplayModel` prefers the LAST routed-model step-finish
 *    part over `info.providerID/modelID`, falls back to info, and returns
 *    null for user messages and when no model info is resolvable.
 *  - `computeMessageModelLabels` labels the FIRST assistant message and
 *    every subsequent assistant message whose resolved model DIFFERS from
 *    the previous assistant's. Same-model follow-ups stay unlabelled; a
 *    user message between two same-model assistants must not break the
 *    gating; the label string is `friendlyModelName(providerID, modelID, options)`.
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

const kiloAutoOption: SessionModelOption = {
  id: 'kilo-auto/efficient',
  name: 'Kilo Auto (efficient)',
  displayId: 'kilo-auto/efficient',
  variants: [],
  isPreferred: true,
  showGatewayMetadata: true,
  provider: { id: 'kilo', name: 'Kilo' },
};

const options: SessionModelOption[] = [catalogOption, kiloAutoOption];

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

describe('computeMessageModelLabels', () => {
  it('labels the first assistant message even when later assistants share the model', () => {
    const m1 = storedMessage(
      assistantInfo({ id: 'a1', providerID: 'kilo', modelID: 'kilo-auto/efficient' })
    );
    const m2 = storedMessage(
      assistantInfo({ id: 'a2', providerID: 'kilo', modelID: 'kilo-auto/efficient' })
    );
    const labels = computeMessageModelLabels([m1, m2], options);
    expect(labels.get('a1')).toBe('Kilo Auto (efficient)');
    // m2 is the same model as m1 → no label.
    expect(labels.has('a2')).toBe(false);
  });

  it('does NOT label a same-model follow-up assistant message', () => {
    const m1 = storedMessage(
      assistantInfo({ id: 'a1', providerID: 'anthropic', modelID: 'claude-sonnet-4' })
    );
    const m2 = storedMessage(
      assistantInfo({ id: 'a2', providerID: 'anthropic', modelID: 'claude-sonnet-4' })
    );
    const labels = computeMessageModelLabels([m1, m2], options);
    expect(labels.size).toBe(1);
    expect(labels.get('a1')).toBe('Claude Sonnet 4');
    expect(labels.has('a2')).toBe(false);
  });

  it('labels a follow-up assistant message when its model DIFFERS from the previous', () => {
    const m1 = storedMessage(
      assistantInfo({ id: 'a1', providerID: 'anthropic', modelID: 'claude-sonnet-4' })
    );
    const m2 = storedMessage(
      assistantInfo({ id: 'a2', providerID: 'kilo', modelID: 'kilo-auto/efficient' })
    );
    const labels = computeMessageModelLabels([m1, m2], options);
    expect(labels.get('a1')).toBe('Claude Sonnet 4');
    expect(labels.get('a2')).toBe('Kilo Auto (efficient)');
  });

  it('does NOT spuriously label when a user message sits between two same-model assistants', () => {
    const user = storedMessage(userInfo({ id: 'u-mid' }));
    const a1 = storedMessage(
      assistantInfo({ id: 'a1', providerID: 'anthropic', modelID: 'claude-sonnet-4' })
    );
    const a2 = storedMessage(
      assistantInfo({ id: 'a2', providerID: 'anthropic', modelID: 'claude-sonnet-4' })
    );
    const labels = computeMessageModelLabels([a1, user, a2], options);
    expect(labels.size).toBe(1);
    expect(labels.get('a1')).toBe('Claude Sonnet 4');
    expect(labels.has('a2')).toBe(false);
  });

  it('returns an empty map when there are no assistant messages', () => {
    const user1 = storedMessage(userInfo({ id: 'u-1' }));
    const user2 = storedMessage(userInfo({ id: 'u-2' }));
    expect(computeMessageModelLabels([user1, user2], options)).toEqual(new Map());
  });

  it('returns an empty map when no assistant message resolves a model', () => {
    const a1 = storedMessage(assistantInfo({ id: 'a1', providerID: '', modelID: '' }));
    const a2 = storedMessage(assistantInfo({ id: 'a2', providerID: '', modelID: '' }));
    expect(computeMessageModelLabels([a1, a2], options)).toEqual(new Map());
  });

  it('treats an unresolvable assistant as transparent: a following resolvable assistant compares against the LAST resolved model, not against null', () => {
    const a1 = storedMessage(
      assistantInfo({ id: 'a1', providerID: 'anthropic', modelID: 'claude-sonnet-4' })
    );
    const aUnresolvable = storedMessage(assistantInfo({ id: 'a2', providerID: '', modelID: '' }));
    const a3 = storedMessage(
      assistantInfo({ id: 'a3', providerID: 'anthropic', modelID: 'claude-sonnet-4' })
    );
    const labels = computeMessageModelLabels([a1, aUnresolvable, a3], options);
    // a1 is labelled (first); a3 shares a1's model and must NOT be labelled.
    expect(labels.size).toBe(1);
    expect(labels.get('a1')).toBe('Claude Sonnet 4');
    expect(labels.has('a3')).toBe(false);
  });

  it('uses the friendlyModelName catalog hit when the resolved model is in the catalog', () => {
    const a1 = storedMessage(
      assistantInfo({ id: 'a1', providerID: 'anthropic', modelID: 'claude-sonnet-4' })
    );
    const labels = computeMessageModelLabels([a1], options);
    expect(labels.get('a1')).toBe('Claude Sonnet 4');
  });

  it('falls back to the cleaned raw modelID via friendlyModelName when the resolved model is NOT in the catalog', () => {
    // Unresolvable id (no catalog hit) → cleaned raw id, with the trailing
    // -YYYYMMDD date suffix stripped. Exercises the "Empty" branch of F3
    // (unresolvable id → never blank).
    const a1 = storedMessage(
      assistantInfo({ id: 'a1', providerID: 'kilo', modelID: 'claude-sonnet-4-20260101' })
    );
    const labels = computeMessageModelLabels([a1], options);
    expect(labels.get('a1')).toBe('claude-sonnet-4');
  });

  it('prefers the LAST routed step-finish model when computing the gate key', () => {
    // m1 used kilo-auto/efficient info, but the LAST routed step-finish
    // ran on anthropic/claude-sonnet-4. m2 is the SAME routed model, so
    // it must NOT be labelled.
    const m1 = storedMessage(
      assistantInfo({ id: 'm1', providerID: 'kilo', modelID: 'kilo-auto/efficient' }),
      [
        stepFinishWithRouted(
          { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
          { id: 'sf-a' }
        ),
        stepFinishWithRouted(
          { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          { id: 'sf-b' }
        ),
      ]
    );
    const m2 = storedMessage(
      assistantInfo({ id: 'm2', providerID: 'anthropic', modelID: 'claude-sonnet-4' }),
      []
    );
    const labels = computeMessageModelLabels([m1, m2], options);
    expect(labels.get('m1')).toBe('Claude Sonnet 4');
    // m2's resolved model === m1's LAST routed model → no label.
    expect(labels.has('m2')).toBe(false);
  });
});
