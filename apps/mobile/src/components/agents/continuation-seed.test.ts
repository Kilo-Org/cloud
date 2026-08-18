import { describe, expect, it, vi } from 'vitest';

import {
  type AssistantMessage,
  type Part,
  type StoredMessage,
  type UserMessage,
} from '@kilocode/cloud-agent-sdk';

import { type InstancePickerInstance } from '@/lib/picker-bridge';

import {
  buildContinuationSeed,
  CONTINUATION_SEED_MAX_CHARS,
  resolveContinuationDestinations,
} from './continuation-seed';

vi.mock('@/components/ui/icons', () => ({
  Bug: 'Bug',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Workflow: 'Workflow',
}));

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function userInfo(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'u-1',
    sessionID: 'ses-1',
    role: 'user',
    time: { created: 1_700_000_000_000 },
    agent: 'build',
    model: { providerID: 'kilo', modelID: 'test-model' },
    ...overrides,
  };
}

function assistantInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'a-1',
    sessionID: 'ses-1',
    role: 'assistant',
    time: { created: 1_700_000_000_000 },
    parentID: 'u-1',
    modelID: 'test-model',
    providerID: 'kilo',
    mode: 'code',
    agent: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function textPart(text: string, overrides: Partial<Part> = {}): Part {
  return {
    id: 'p-text',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'text',
    text,
    ...overrides,
  } as unknown as Part;
}

function reasoningPart(id = 'p-reason'): Part {
  return {
    id,
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'reasoning',
    text: 'thinking...',
  } as unknown as Part;
}

function toolPart(id = 'p-tool'): Part {
  return {
    id,
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'tool',
    name: 'read',
    input: {},
    callID: 'call-1',
  } as unknown as Part;
}

function storedMessage(info: UserMessage | AssistantMessage, parts: Part[] = []): StoredMessage {
  return { info, parts };
}

const INSTANCE_A: InstancePickerInstance = {
  connectionId: 'c1',
  name: 'mac-mini',
  projectName: 'cloud',
};

const INSTANCE_B: InstancePickerInstance = {
  connectionId: 'c2',
  name: 'linux-box',
  projectName: 'prod',
};

// ---------------------------------------------------------------------------
// buildContinuationSeed
// ---------------------------------------------------------------------------

describe('buildContinuationSeed', () => {
  it('extracts user and assistant text turns in order, skipping non-text parts and empty texts', () => {
    const messages: StoredMessage[] = [
      storedMessage(userInfo({ id: 'u1' }), [textPart('hello')]),
      storedMessage(assistantInfo({ id: 'a1' }), [textPart('hi there'), reasoningPart()]),
      storedMessage(userInfo({ id: 'u2' }), [
        textPart('visible', { id: 'p1' }),
        textPart('synthetic', { id: 'p2', synthetic: true } as unknown as Partial<Part>),
      ]),
      storedMessage(assistantInfo({ id: 'a2' }), [
        textPart('shown', { id: 'p3' }),
        textPart('ignored', { id: 'p4', ignored: true } as unknown as Partial<Part>),
      ]),
      storedMessage(userInfo({ id: 'u3' }), [reasoningPart('r1'), toolPart('t1')]),
      storedMessage(userInfo({ id: 'u4' }), [textPart('')]),
    ];

    const seed = buildContinuationSeed(messages);
    expect(seed).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    const s = seed!;
    expect(s).toContain('User:\nhello');
    expect(s).toContain('Assistant:\nhi there');
    expect(s).toContain('User:\nvisible');
    expect(s).toContain('Assistant:\nshown');
    // Synthetic text must not appear.
    expect(s).not.toContain('synthetic');
    // Ignored text must not appear.
    expect(s).not.toContain('ignored');
    // Non-text-only messages produce no text, so u3 and u4 are skipped.
    // The preamble must appear exactly once.
    const preambleCount = s.split('You are continuing a conversation').length - 1;
    expect(preambleCount).toBe(1);
    // No omission marker for a short transcript.
    expect(s).not.toContain('[… middle of the transcript');
  });

  it('returns null for an empty array', () => {
    expect(buildContinuationSeed([])).toBeNull();
  });

  it('returns null for messages with no eligible text parts', () => {
    const messages: StoredMessage[] = [
      storedMessage(userInfo(), [reasoningPart(), toolPart()]),
      storedMessage(assistantInfo(), [textPart('')]),
    ];
    expect(buildContinuationSeed(messages)).toBeNull();
  });

  it('produces a seed with the preamble once and every turn, no omission marker, for a short transcript', () => {
    const messages: StoredMessage[] = [
      storedMessage(userInfo({ id: 'u1' }), [textPart('what is the key phrase?')]),
      storedMessage(assistantInfo({ id: 'a1' }), [textPart('the key phrase is "pineapple23"')]),
    ];

    const seed = buildContinuationSeed(messages);
    expect(seed).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    const s = seed!;
    expect(s).toContain('User:\nwhat is the key phrase?');
    expect(s).toContain('Assistant:\nthe key phrase is "pineapple23"');
    expect(s).toContain('You are continuing a conversation');
    // Exactly one preamble.
    expect(s.split('You are continuing a conversation').length - 1).toBe(1);
    expect(s).not.toContain('[… middle of the transcript');
    expect(s.length).toBeLessThanOrEqual(CONTINUATION_SEED_MAX_CHARS);
  });

  it('truncates a long transcript: first turn, omission marker, and last turn fit', () => {
    // 5 turns, each ~1000 chars of text → full serialized transcript
    // exceeds CONTINUATION_SEED_MAX_CHARS.
    const chunk = 'x'.repeat(990);
    const messages: StoredMessage[] = [
      storedMessage(userInfo({ id: 'first' }), [textPart(`first ${chunk}`)]),
      storedMessage(assistantInfo({ id: 'mid1' }), [textPart(`middle1 ${chunk}`)]),
      storedMessage(userInfo({ id: 'mid2' }), [textPart(`middle2 ${chunk}`)]),
      storedMessage(assistantInfo({ id: 'mid3' }), [textPart(`middle3 ${chunk}`)]),
      storedMessage(userInfo({ id: 'last' }), [textPart(`last ${'y'.repeat(500)}`)]),
    ];

    const seed = buildContinuationSeed(messages);
    expect(seed).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    const s = seed!;
    expect(s.length).toBeLessThanOrEqual(CONTINUATION_SEED_MAX_CHARS);

    // First turn must be present.
    expect(s).toContain('first ');
    // Omission marker must appear.
    expect(s).toContain('[… middle of the transcript');
    // Last turn must be present.
    expect(s).toContain('last ');
  });

  it('handles a two-turn transcript whose second turn is oversized', () => {
    // First turn is short; second turn is so long that head + marker + second
    // would exceed the body budget.  Result: first turn + marker, no tail.
    const oversized = 'z'.repeat(5000);
    const messages: StoredMessage[] = [
      storedMessage(userInfo({ id: 'u1' }), [textPart('short first turn')]),
      storedMessage(assistantInfo({ id: 'a1' }), [textPart(oversized)]),
    ];

    const seed = buildContinuationSeed(messages);
    expect(seed).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    const s = seed!;
    expect(s.length).toBeLessThanOrEqual(CONTINUATION_SEED_MAX_CHARS);
    expect(s).toContain('User:\nshort first turn');
    expect(s).toContain('[… middle of the transcript');
    // The oversized second turn must not appear.
    expect(s).not.toContain('zzzzzzzz');
  });

  it('handles a single oversized first turn with no omission marker', () => {
    const oversized = 'w'.repeat(5000);
    const messages: StoredMessage[] = [
      storedMessage(userInfo({ id: 'only' }), [textPart(oversized)]),
    ];

    const seed = buildContinuationSeed(messages);
    expect(seed).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    const s = seed!;
    expect(s.length).toBeLessThanOrEqual(CONTINUATION_SEED_MAX_CHARS);
    // A truncated slice of the original text must appear.
    expect(s).toContain('wwww');
    // Single turn → no marker.
    expect(s).not.toContain('[… middle of the transcript');
  });
});

// ---------------------------------------------------------------------------
// resolveContinuationDestinations
// ---------------------------------------------------------------------------

describe('resolveContinuationDestinations', () => {
  const GIT_URL = 'https://github.com/owner/repo.git';
  const REPOS = [{ fullName: 'owner/repo' }];
  const MODELS = [{ id: 'test-model', variants: ['default'] }];

  it('returns cloud destination first when repo and model resolve', () => {
    const result = resolveContinuationDestinations({
      gitUrl: GIT_URL,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      repositories: REPOS,
      models: MODELS,
      instances: [INSTANCE_A],
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      kind: 'cloud-agent',
      repo: 'owner/repo',
      model: 'test-model',
      variant: 'default',
    });
    expect(result[1]).toEqual({ kind: 'remote', instance: INSTANCE_A });
  });

  it('omits cloud destination when repo is absent from repositories', () => {
    const result = resolveContinuationDestinations({
      gitUrl: GIT_URL,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      // repo "owner/repo" is not listed.
      repositories: [],
      models: MODELS,
      instances: [INSTANCE_A],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: 'remote', instance: INSTANCE_A });
  });

  it('omits cloud destination when gitUrl is null', () => {
    const result = resolveContinuationDestinations({
      gitUrl: null,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      repositories: REPOS,
      models: MODELS,
      instances: [INSTANCE_A],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: 'remote', instance: INSTANCE_A });
  });

  it('omits cloud destination when model is absent from models', () => {
    const result = resolveContinuationDestinations({
      gitUrl: GIT_URL,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      repositories: REPOS,
      // model not found.
      models: [],
      instances: [INSTANCE_A],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: 'remote', instance: INSTANCE_A });
  });

  it('returns two remote destinations in order', () => {
    const result = resolveContinuationDestinations({
      gitUrl: null,
      mode: 'code',
      model: 'test-model',
      variant: 'default',
      repositories: REPOS,
      models: MODELS,
      instances: [INSTANCE_A, INSTANCE_B],
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ kind: 'remote', instance: INSTANCE_A });
    expect(result[1]).toEqual({ kind: 'remote', instance: INSTANCE_B });
  });

  it('returns an empty array when everything is empty', () => {
    const result = resolveContinuationDestinations({
      gitUrl: null,
      mode: 'code',
      model: '',
      variant: '',
      repositories: [],
      models: [],
      instances: [],
    });

    expect(result).toEqual([]);
  });
});
