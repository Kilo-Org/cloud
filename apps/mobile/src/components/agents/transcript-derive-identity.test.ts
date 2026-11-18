import { type Part, type ReasoningPart, type TextPart } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { withoutReasoningParts } from '@/components/agents/part-types';
import { mergeSessionTranscript } from '@/components/agents/session-transcript';

// `session-transcript` pulls `session-tool-run`, whose tool-card projection
// imports the lucide icon barrel. The pure project cannot parse the Flow-sourced
// react-native runtime, so stub the icon module with sentinels (same set the
// session-transcript tests stub).
vi.mock('@/components/ui/icons', () => ({
  Cpu: 'Cpu',
  Eye: 'Eye',
  FileDiff: 'FileDiff',
  FilePlus: 'FilePlus',
  FileSearch: 'FileSearch',
  FolderOpen: 'FolderOpen',
  Globe: 'Globe',
  ListTodo: 'ListTodo',
  Pencil: 'Pencil',
  Plug: 'Plug',
  Search: 'Search',
  Sparkles: 'Sparkles',
  Terminal: 'Terminal',
}));

const SESSION_ID = 'ses_12345678901234567890123456';
const BASE = 1_000_000_000;

function reasoningPart(messageID: string, text: string): ReasoningPart {
  return {
    id: `${messageID}:reasoning`,
    sessionID: SESSION_ID,
    messageID,
    type: 'reasoning',
    text,
    time: { start: 1, end: 2 },
  };
}

function textPart(messageID: string, text: string): TextPart {
  return {
    id: `${messageID}:text`,
    sessionID: SESSION_ID,
    messageID,
    type: 'text',
    text,
    time: { start: 1, end: 2 },
  };
}

function message(id: string, created: number, parts: Part[]) {
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: 'assistant' as const,
      time: { created },
      parentID: 'm0',
      modelID: 'model',
      providerID: 'kilo',
      mode: 'code',
      agent: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  };
}

function attempt(id: string, triggerMessageId: string) {
  return {
    id,
    triggerMessageId,
    status: 'completed' as const,
    startedAt: 1,
    completedAt: 2,
    revision: 1,
    // A real cold-start attempt records a substantive step; without one a
    // completed attempt is a warm-reuse no-op and would be hidden.
    steps: [
      {
        id: `${id}:step`,
        key: 'cloning',
        kind: 'phase' as const,
        label: 'cloning',
        status: 'completed' as const,
        startedAt: 1,
        revision: 1,
      },
    ],
  };
}

describe('transcript derive identity', () => {
  it('reuses the derived object for an unchanged reasoning-bearing message', () => {
    const source = message('m1', BASE, [reasoningPart('m1', 'thinking'), textPart('m1', 'answer')]);

    const first = withoutReasoningParts([source]);
    const second = withoutReasoningParts([source]);

    // The first pass must strip (a new object), the second must hand back the
    // exact same derived object so a memoized row never churns.
    const reused = first[0] !== source && second[0] === first[0];
    // eslint-disable-next-line no-console -- the PR proof greps this derive-reuse marker
    console.log(`KWF_DERIVE withoutReasoning reused: ${reused}`);

    expect(first[0]).not.toBe(source);
    expect(first[0]?.parts.map(part => part.type)).toEqual(['text']);
    expect(second[0]).toBe(first[0]);
  });

  it('reuses every unchanged item when only the last message changes', () => {
    const firstMessage = message('m1', BASE, [
      reasoningPart('m1', 'thinking'),
      textPart('m1', 'a'),
    ]);
    const secondMessage = message('m2', BASE + 60_000, [textPart('m2', 'b')]);
    const attempts = [attempt('attempt_1', 'm1')];

    // Production derives the visible rows in this order: strip hidden reasoning
    // first, then merge the transcript items.
    const before = mergeSessionTranscript(
      withoutReasoningParts([firstMessage, secondMessage]),
      attempts
    );

    // The SDK keeps an untouched row's `StoredMessage` identity across a delta on
    // another row, so only the changed row's object is new here.
    const changed = message('m2', BASE + 60_000, [textPart('m2', 'b changed')]);
    const after = mergeSessionTranscript(withoutReasoningParts([firstMessage, changed]), attempts);

    // Order: m1 message, its preparation attempt, then m2 message.
    const firstItemReused = after[0] === before[0];
    const changedItemRebuilt = after[2] !== before[2];
    // eslint-disable-next-line no-console -- the PR proof greps these merge markers
    console.log(`KWF_DERIVE merge firstItem reused: ${firstItemReused}`);
    // eslint-disable-next-line no-console -- the PR proof greps these merge markers
    console.log(`KWF_DERIVE merge changedItem rebuilt: ${changedItemRebuilt}`);

    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(after[2]).toMatchObject({ type: 'message', message: changed });

    // The stripped m1 object is reused even though this pass re-derived the list.
    const firstPass = withoutReasoningParts([firstMessage, secondMessage]);
    const secondPass = withoutReasoningParts([firstMessage, changed]);
    expect(secondPass[0]).toBe(firstPass[0]);
  });

  it('rebuilds the derived object when the message object itself changes', () => {
    const original = message('m1', BASE, [reasoningPart('m1', 'thinking'), textPart('m1', 'a')]);
    const first = withoutReasoningParts([original]);

    const updated = message('m1', BASE, [
      reasoningPart('m1', 'thinking more'),
      textPart('m1', 'a'),
    ]);
    const second = withoutReasoningParts([updated]);

    expect(second[0]).not.toBe(first[0]);
    expect(second[0]?.parts.map(part => part.type)).toEqual(['text']);
  });
});
