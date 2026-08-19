import { describe, expect, it, vi } from 'vitest';

import {
  type AssistantMessage,
  type Part,
  type StoredMessage,
  type UserMessage,
} from '@kilocode/cloud-agent-sdk';

import { buildContinuationSeed } from '@/components/agents/continuation-seed';

vi.mock('@/components/ui/icons', () => ({
  Bug: 'Bug',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Workflow: 'Workflow',
}));

// ---------------------------------------------------------------------------
// Fixtures (minimal, mirrors continuation-seed.test.ts)
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

function storedMessage(info: UserMessage | AssistantMessage, parts: Part[] = []): StoredMessage {
  return { info, parts };
}

// ---------------------------------------------------------------------------
// Continue-seed provenance: the seed is the visible transcript, never a hidden
// composer buffer.
//
// Structural reason this path is impossible: `useContinueSession.continueSession`
// (use-continue-session.ts) builds the seed from
// `store.get(manager.atoms.messagesList)` — the submitted transcript — and
// passes it to `buildContinuationSeed`. It never reads the new-session draft,
// which lives under `NEW_SESSION_DRAFT_KEY` in the encrypted KV store and is
// read only by `loadDraft`/`useFencedDraftLoad` in `new.tsx`. The two data
// sources are disjoint, so a cleared or unseen draft — text that exists only
// in the composer/KV store and was never submitted into `messagesList` — can
// never become the continue seed.
//
// The tests below pin the consequence: `buildContinuationSeed` derives its
// body exactly from the `messages` argument, so no text outside the transcript
// can be injected.
// ---------------------------------------------------------------------------

describe('continue seed provenance (draft cannot seed)', () => {
  it('returns null for an empty transcript, so a draft alone cannot seed', () => {
    expect(buildContinuationSeed([])).toBeNull();
  });

  it('derives the seed body exactly from the visible transcript', () => {
    const messages: StoredMessage[] = [
      storedMessage(userInfo(), [textPart('visible user turn')]),
      storedMessage(assistantInfo(), [textPart('visible assistant reply')]),
    ];

    const seed = buildContinuationSeed(messages);
    expect(seed).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    const s = seed!;

    // The seed is the fixed preamble plus the serialized transcript. The body
    // (everything after the preamble) must be exactly the transcript turns —
    // no draft text, no hidden composer buffer can be injected.
    const bodyStart = s.indexOf('User:\n');
    expect(bodyStart).toBeGreaterThan(0);
    expect(s.slice(bodyStart)).toBe(
      'User:\nvisible user turn\n\nAssistant:\nvisible assistant reply'
    );
  });

  it('derives the seed body exactly from a transcript with a draft-like string absent', () => {
    // A draft string that is not part of any submitted message must not appear
    // in the seed, because the seed body is exactly the transcript.
    const draftText = 'text the user discarded from the composer';
    const messages: StoredMessage[] = [storedMessage(userInfo(), [textPart('only this turn')])];

    const seed = buildContinuationSeed(messages);
    expect(seed).not.toBeNull();
    // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- guarded by expect above
    const s = seed!;

    const bodyStart = s.indexOf('User:\n');
    expect(bodyStart).toBeGreaterThan(0);
    // Exact body: the transcript turn only, so the discarded draft cannot appear.
    expect(s.slice(bodyStart)).toBe('User:\nonly this turn');
    expect(s).not.toContain(draftText);
  });
});
