import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AssistantMessage,
  type Part,
  type StepFinishPart,
  type StoredMessage,
  type UserMessage,
} from 'cloud-agent-sdk';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { formatMessageSentTime, getMessageDetailsContent } from './message-details-content';

const performCopyMock = vi.fn().mockResolvedValue(undefined);
const showActionSheetWithOptions = vi.fn();

vi.mock('./use-message-copy', () => ({
  performCopy: (...args: unknown[]) => performCopyMock(...args),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  ActionSheetIOS: {
    showActionSheetWithOptions: (...args: unknown[]) => showActionSheetWithOptions(...args),
  },
}));

function assistantInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'msg-1',
    sessionID: 'ses-1',
    role: 'assistant',
    time: { created: 1_700_000_000_000 },
    parentID: 'msg-0',
    modelID: 'claude-sonnet-4',
    providerID: 'kilo',
    mode: 'code',
    agent: 'test',
    path: { cwd: '/', root: '/' },
    cost: 0.0123,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 10,
      cache: { read: 5, write: 2 },
    },
    ...overrides,
  };
}

function userInfo(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'u-1',
    sessionID: 'ses-1',
    role: 'user',
    time: { created: 1_700_000_000_000 },
    agent: 'test',
    model: { providerID: 'kilo', modelID: 'claude-sonnet-4' },
    ...overrides,
  };
}

function textPart(text: string, id = 'p-text'): Part {
  return {
    id,
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'text',
    text,
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

function stepFinishWithRouted(
  routed: { providerID: string; modelID: string },
  overrides: Partial<StepFinishPart> = {}
): StepFinishPart {
  return Object.assign(stepFinish(overrides), { model: routed }) as StepFinishPart;
}

function storedMessage(info: AssistantMessage | UserMessage, parts: Part[] = []): StoredMessage {
  return { info, parts };
}

const catalogOptions: SessionModelOption[] = [
  {
    id: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    displayId: 'anthropic/claude-sonnet-4',
    variants: [],
    isPreferred: false,
    showGatewayMetadata: false,
    modelRef: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
    provider: { id: 'kilo', name: 'Kilo' },
  },
  {
    id: 'kilo-auto/efficient',
    name: 'Auto Efficient',
    displayId: 'kilo-auto/efficient',
    variants: [],
    isPreferred: false,
    showGatewayMetadata: true,
    provider: { id: 'kilo', name: 'Kilo' },
  },
];

describe('formatMessageSentTime', () => {
  it('formats a finite positive epoch ms timestamp', () => {
    const label = formatMessageSentTime(1_700_000_000_000);
    expect(label).not.toBeNull();
    expect(typeof label).toBe('string');
    expect((label ?? '').length).toBeGreaterThan(0);
  });

  it('returns null when the timestamp is absent or invalid', () => {
    expect(formatMessageSentTime(undefined)).toBeNull();
    expect(formatMessageSentTime(null)).toBeNull();
    expect(formatMessageSentTime(0)).toBeNull();
    expect(formatMessageSentTime(Number.NaN)).toBeNull();
    expect(formatMessageSentTime(-1)).toBeNull();
  });
});

describe('getMessageDetailsContent — happy', () => {
  it('projects a user message with role, sent time, and copy text (no model/cost)', () => {
    const message = storedMessage(userInfo(), [textPart('hello world')]);
    const content = getMessageDetailsContent(message, catalogOptions);

    expect(content.roleLabel).toBe('User');
    expect(content.sentTimeLabel).not.toBeNull();
    expect(content.copyableText).toBe('hello world');
    expect(content.modelLabel).toBeNull();
    expect(content.costLabel).toBeNull();
    expect(content.tokenRows).toBeNull();
  });

  it('projects an assistant message with model, cost, and token rows', () => {
    const info = assistantInfo({
      providerID: 'kilo',
      modelID: 'kilo-auto/efficient',
      cost: 0.0123,
      tokens: {
        input: 100,
        output: 50,
        reasoning: 10,
        cache: { read: 5, write: 2 },
      },
    });
    const routed = stepFinishWithRouted({
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
    });
    const message = storedMessage(info, [textPart('assistant reply'), routed]);
    const content = getMessageDetailsContent(message, catalogOptions);

    expect(content.roleLabel).toBe('Assistant');
    expect(content.sentTimeLabel).not.toBeNull();
    expect(content.copyableText).toBe('assistant reply');
    // Routed stamp preferred; catalog-friendly name.
    expect(content.modelLabel).toBe('Claude Sonnet 4');
    expect(content.costLabel).toBe('$0.0123');
    expect(content.tokenRows).toEqual([
      { label: 'Input', value: 100 },
      { label: 'Output', value: 50 },
      { label: 'Reasoning', value: 10 },
      { label: 'Cache read', value: 5 },
      { label: 'Cache write', value: 2 },
      { label: 'Total', value: 167 },
    ]);
  });

  it('shows the info-level auto model when no routed stamp exists (explicit detail)', () => {
    const info = assistantInfo({
      providerID: 'kilo',
      modelID: 'kilo-auto/efficient',
      cost: 0.001,
      tokens: {
        input: 1,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });
    const message = storedMessage(info, [textPart('hi')]);
    const content = getMessageDetailsContent(message, catalogOptions);
    expect(content.modelLabel).toBe('Auto Efficient');
  });
});

describe('getMessageDetailsContent — empty', () => {
  it('omits the model row when the assistant model is unresolvable', () => {
    const info = assistantInfo({
      providerID: '',
      modelID: '',
      cost: 0.01,
      tokens: {
        input: 10,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });
    const message = storedMessage(info, [textPart('no model')]);
    const content = getMessageDetailsContent(message, catalogOptions);
    expect(content.roleLabel).toBe('Assistant');
    expect(content.modelLabel).toBeNull();
    expect(content.costLabel).not.toBeNull();
    expect(content.tokenRows).not.toBeNull();
  });

  it('omits the cost/tokens block when cost and all five token values are zero', () => {
    const info = assistantInfo({
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });
    const message = storedMessage(info, [textPart('aborted')]);
    const content = getMessageDetailsContent(message, catalogOptions);
    expect(content.roleLabel).toBe('Assistant');
    expect(content.modelLabel).toBe('claude-sonnet-4');
    expect(content.costLabel).toBeNull();
    expect(content.tokenRows).toBeNull();
    expect(content.copyableText).toBe('aborted');
  });

  it('hides Copy when there is no copyable text', () => {
    const message = storedMessage(userInfo(), []);
    const content = getMessageDetailsContent(message, catalogOptions);
    expect(content.copyableText).toBeNull();
    expect(content.roleLabel).toBe('User');
  });

  it('hides Sent when the created timestamp is missing', () => {
    const info = userInfo({
      time: { created: 0 },
    });
    const message = storedMessage(info, [textPart('x')]);
    const content = getMessageDetailsContent(message, catalogOptions);
    expect(content.sentTimeLabel).toBeNull();
  });
});

describe('MessageDetailsSheet copy button wiring (retryable unhappy)', () => {
  beforeEach(() => {
    performCopyMock.mockReset().mockResolvedValue(undefined);
    showActionSheetWithOptions.mockReset();
  });

  it('forwards copyable text to shared performCopy (no ActionSheet)', async () => {
    // Contract: details Copy uses handleMessageDetailsCopy → shared performCopy.
    // No ActionSheet (that path is for long-press message copy on iOS).
    // Sheet onPress wires to this handler (see message-details-sheet.tsx).
    const message = storedMessage(userInfo(), [textPart('copy me')]);
    const content = getMessageDetailsContent(message, catalogOptions);
    expect(content.copyableText).toBe('copy me');

    const { handleMessageDetailsCopy } = await import('./message-details-copy');
    handleMessageDetailsCopy(content.copyableText);

    expect(performCopyMock).toHaveBeenCalledWith('copy me');
    expect(performCopyMock).toHaveBeenCalledTimes(1);
    expect(showActionSheetWithOptions).not.toHaveBeenCalled();
  });

  it('no-ops when copyable text is absent', async () => {
    const { handleMessageDetailsCopy } = await import('./message-details-copy');
    handleMessageDetailsCopy(null);
    handleMessageDetailsCopy(undefined);
    handleMessageDetailsCopy('');
    expect(performCopyMock).not.toHaveBeenCalled();
    expect(showActionSheetWithOptions).not.toHaveBeenCalled();
  });
});
