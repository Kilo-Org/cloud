/**
 * Unit tests for the durable half of the fake LLM state.
 *
 * The Node runtime never evicts; these bounds apply to the serialized snapshot
 * only and are what the Durable Object persists and hydrates.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  FAKE_SCOPE_MARKER_PREFIX,
  MAX_PERSISTED_SCENARIOS,
  MAX_PERSISTED_SCOPES,
  MAX_PERSISTED_TAG_LENGTH,
  MAX_SLOW_DELAY_MS,
  createFakeLlmState,
  extractPromptScope,
  handleFakeLlmRequest,
  hydrateFakeLlmState,
  serializeFakeLlmState,
  type FakeLlmEmit,
  type FakeLlmRequest,
  type FakeLlmState,
  type PersistedFakeLlmState,
} from '../../e2e/fake-llm-core.js';

function stubEmit(): FakeLlmEmit {
  return {
    start() {},
    sse() {},
    done() {},
    json() {},
    empty() {},
    fail() {},
    end() {},
    isStarted() {
      return false;
    },
    onClose() {},
  };
}

function seedScenario(state: FakeLlmState, tag: string, requests = 1): void {
  state.scenarios.set(tag, {
    tag,
    requests,
    toolCalls: { write: 0, read: 0, edit: 0, question: 0 },
    toolResults: { write: 0, read: 0, edit: 0, question: 0 },
    unsupportedToolSchema: false,
    seenToolResults: new Set(),
    fileCompleted: false,
  });
}

const TEST_ADMIN_TOKEN = 'fake-llm-state-test-admin';

/**
 * Touch a scenario tag through the real producer entry (`handleFakeLlmRequest`),
 * the same core function the Node server and the Worker Durable Object
 * dispatch through. `scenarioStatus` returns an existing entry without
 * re-inserting it, so a second touch leaves the tag's Map position unchanged:
 * FIFO-on-first-touch, not LRU-on-last-touch.
 *
 * `question:<tag>` is used because it is a tag-counted scenario
 * (`directiveTag` at `fake-llm-core.ts`) that completes without parking when no
 * tools are advertised. `echo` is deliberately not tag-counted, so an
 * `echo:<tag>` request never reaches `scenarioStatus` and cannot touch counters.
 */
async function touchTag(state: FakeLlmState, tag: string): Promise<void> {
  const request: FakeLlmRequest = {
    method: 'POST',
    url: '/api/openrouter/chat/completions',
    headers: { 'content-type': 'application/json' },
    readText: async () =>
      JSON.stringify({
        model: 'kilo/fake-deterministic',
        messages: [{ role: 'user', content: `__fake__:question:${tag}:ping` }],
        stream: true,
      }),
  };
  await handleFakeLlmRequest(request, stubEmit(), state, { adminToken: TEST_ADMIN_TOKEN });
}

function slowChatRequest(content: string): FakeLlmRequest {
  return {
    method: 'POST',
    url: '/api/openrouter/chat/completions',
    headers: { 'content-type': 'application/json' },
    readText: async () =>
      JSON.stringify({
        model: 'kilo/fake-deterministic',
        messages: [{ role: 'user', content }],
        stream: true,
      }),
  };
}

/**
 * Minimal emit that records SSE traffic. `alreadyClosed` mirrors the Worker
 * adapter, which invokes a listener synchronously when the stream is already
 * gone; `closeAfterContentChunks` simulates a client disconnect mid-stream.
 */
function recordingEmit(
  options: { alreadyClosed?: boolean; closeAfterContentChunks?: number } = {}
): { emit: FakeLlmEmit; contentChunks: () => number } {
  const listeners: Array<() => void> = [];
  let contentChunks = 0;

  return {
    contentChunks: () => contentChunks,
    emit: {
      start() {},
      sse(chunk) {
        const content = (chunk as { choices?: Array<{ delta?: { content?: unknown } }> })
          .choices?.[0]?.delta?.content;
        if (typeof content !== 'string' || content.length === 0) return;
        contentChunks += 1;
        if (contentChunks === options.closeAfterContentChunks) {
          for (const listener of listeners) listener();
        }
      },
      done() {},
      json() {},
      empty() {},
      fail() {},
      end() {},
      isStarted() {
        return false;
      },
      onClose(listener) {
        if (options.alreadyClosed) listener();
        else listeners.push(listener);
      },
    },
  };
}

describe('serializeFakeLlmState', () => {
  it('keeps counters, nextRequestId and unexpired release follow-ups', () => {
    const state = createFakeLlmState();
    state.nextRequestId = 7;
    state.chatCompletionRequests = 3;
    state.transcriptionRequests = 2;
    state.releasedGateFollowups.set('live', Date.now() + 5_000);
    state.releasedGateFollowups.set('dead', Date.now() - 1);

    const persisted = serializeFakeLlmState(state);

    expect(persisted.nextRequestId).toBe(7);
    expect(persisted.chatCompletionRequests).toBe(3);
    expect(persisted.transcriptionRequests).toBe(2);
    expect(persisted.releasedGateFollowups).toEqual([['live', expect.any(Number)]]);
  });

  it('bounds scenarios by count in insertion (FIFO) order', () => {
    const state = createFakeLlmState();
    for (let i = 0; i < MAX_PERSISTED_SCENARIOS + 5; i++) {
      seedScenario(state, `t${i}`, i + 1);
    }

    const persisted = serializeFakeLlmState(state);

    expect(persisted.scenarios).toHaveLength(MAX_PERSISTED_SCENARIOS);
    expect(persisted.scenarios[0]?.tag).toBe('t5');
    expect(persisted.scenarios.at(-1)?.tag).toBe(`t${MAX_PERSISTED_SCENARIOS + 4}`);
    expect(persisted.scenarios.some(scenario => scenario.tag === 't0')).toBe(false);
  });

  it('keeps scoped completion counts and bounds them in FIFO order', () => {
    const state = createFakeLlmState();
    for (let i = 0; i < MAX_PERSISTED_SCOPES + 5; i++) {
      state.scopedChatCompletionRequests.set(`s${i}`, i + 1);
    }

    const persisted = serializeFakeLlmState(state);

    expect(persisted.scopedChatCompletionRequests).toHaveLength(MAX_PERSISTED_SCOPES);
    expect(persisted.scopedChatCompletionRequests?.[0]).toEqual(['s5', 6]);
    expect(persisted.scopedChatCompletionRequests?.at(-1)?.[0]).toBe(
      `s${MAX_PERSISTED_SCOPES + 4}`
    );
  });

  it('skips tags longer than the persisted tag bound', () => {
    const state = createFakeLlmState();
    const longTag = 'x'.repeat(MAX_PERSISTED_TAG_LENGTH + 1);
    state.scenarios.set(longTag, {
      tag: longTag,
      requests: 1,
      toolCalls: { write: 0, read: 0, edit: 0, question: 0 },
      toolResults: { write: 0, read: 0, edit: 0, question: 0 },
      unsupportedToolSchema: false,
      seenToolResults: new Set(),
      fileCompleted: false,
    });
    seedScenario(state, 'short', 2);

    const persisted = serializeFakeLlmState(state);
    expect(persisted.scenarios.map(scenario => scenario.tag)).toEqual(['short']);
  });
});

describe('hydrateFakeLlmState', () => {
  it('round-trips counters, scenarios and dedup state', () => {
    const state = createFakeLlmState();
    state.nextRequestId = 11;
    state.chatCompletionRequests = 4;
    state.transcriptionRequests = 1;
    state.releasedGateFollowups.set('live', Date.now() + 5_000);
    state.scenarios.set('writer', {
      tag: 'writer',
      requests: 2,
      toolCalls: { write: 1, read: 0, edit: 0, question: 0 },
      toolResults: { write: 1, read: 0, edit: 0, question: 0 },
      unsupportedToolSchema: true,
      seenToolResults: new Set(['call_abc_write']),
      fileCompleted: true,
    });

    const hydrated = hydrateFakeLlmState(serializeFakeLlmState(state));

    expect(hydrated.nextRequestId).toBe(11);
    expect(hydrated.chatCompletionRequests).toBe(4);
    expect(hydrated.transcriptionRequests).toBe(1);
    expect([...hydrated.releasedGateFollowups.keys()]).toEqual(['live']);
    const writer = hydrated.scenarios.get('writer');
    expect(writer).toMatchObject({
      tag: 'writer',
      requests: 2,
      unsupportedToolSchema: true,
      toolCalls: { write: 1 },
      toolResults: { write: 1 },
    });
    expect([...(writer?.seenToolResults ?? [])]).toEqual(['call_abc_write']);
    expect(writer?.fileCompleted).toBe(true);
  });

  it('round-trips scoped completion counts and tolerates their absence', () => {
    const state = createFakeLlmState();
    state.scopedChatCompletionRequests.set('shardA', 2);

    const hydrated = hydrateFakeLlmState(serializeFakeLlmState(state));
    expect(hydrated.scopedChatCompletionRequests.get('shardA')).toBe(2);

    const legacy = hydrateFakeLlmState({
      nextRequestId: 1,
      chatCompletionRequests: 0,
      transcriptionRequests: 0,
      releasedGateFollowups: [],
      scenarios: [],
    });
    expect(legacy.scopedChatCompletionRequests.size).toBe(0);
  });

  it('always starts with empty transient maps', () => {
    const state = createFakeLlmState();
    seedScenario(state, 't1');
    state.gates.set('t1', [
      { emit: stubEmit(), model: 'fake-deterministic', release() {}, cleanup() {} },
    ]);
    state.liveResponses.add(stubEmit());

    const hydrated = hydrateFakeLlmState(serializeFakeLlmState(state));

    expect(hydrated.gates.size).toBe(0);
    expect(hydrated.liveResponses.size).toBe(0);
  });

  it('returns an empty state for a missing snapshot and tolerates partial data', () => {
    expect(hydrateFakeLlmState(undefined).scenarios.size).toBe(0);
    expect(hydrateFakeLlmState(null).chatCompletionRequests).toBe(0);

    const partial = hydrateFakeLlmState({
      nextRequestId: 2,
    } as PersistedFakeLlmState);
    expect(partial.nextRequestId).toBe(2);
    expect(partial.scenarios.size).toBe(0);
    expect(partial.gates.size).toBe(0);
  });

  it('evicts the oldest first, so a reused early tag loses its counters', async () => {
    // FIFO on insertion order (`scenarioStatus` returns an existing entry
    // without re-inserting it), so an early tag reused but never re-inserted is
    // evicted from the snapshot first: its deployed counters restart at zero
    // when it is touched again. The newest tags survive. The live Node map
    // keeps every tag either way.
    //
    // Both touches of the reused tag go through the real producer
    // (`handleFakeLlmRequest`), and the SECOND touch happens after the newer
    // tags are seeded. A last-touch refresh (LRU) would move the tag to the end
    // and retain it; the absence below pins FIFO-on-first-touch.
    const state = createFakeLlmState();
    await touchTag(state, 'old-reused');
    for (let i = 0; i < MAX_PERSISTED_SCENARIOS - 1; i++) {
      seedScenario(state, `newer${i}`, 1);
    }
    await touchTag(state, 'old-reused');
    seedScenario(state, 'first-touched-beyond-bound', 4);

    expect(state.scenarios.size).toBe(MAX_PERSISTED_SCENARIOS + 1);
    // Both producer touches counted on the same existing entry.
    expect(state.scenarios.get('old-reused')?.requests).toBe(2);

    const hydrated = hydrateFakeLlmState(serializeFakeLlmState(state));

    expect(hydrated.scenarios.size).toBe(MAX_PERSISTED_SCENARIOS);
    // The oldest entry is evicted, so its counters restart at zero.
    expect(hydrated.scenarios.get('old-reused')).toBeUndefined();
    // The newest entries survive, including one first touched beyond the bound.
    expect(hydrated.scenarios.get('newer0')?.requests).toBe(1);
    expect(hydrated.scenarios.get('first-touched-beyond-bound')?.requests).toBe(4);
    // The live map is untouched by the snapshot bound.
    expect(state.scenarios.get('old-reused')?.requests).toBe(2);
  });
});

describe('extractPromptScope', () => {
  it('splits a leading marker from the prompt and strips the newline', () => {
    expect(extractPromptScope(`${FAKE_SCOPE_MARKER_PREFIX}shardA\n__fake__:echo:hi`)).toEqual({
      scope: 'shardA',
      text: '__fake__:echo:hi',
    });
  });

  it('returns the text unchanged when no marker is present', () => {
    expect(extractPromptScope('__fake__:echo:hi')).toEqual({
      scope: undefined,
      text: '__fake__:echo:hi',
    });
  });

  it('ignores a malformed marker without stripping text', () => {
    const text = `${FAKE_SCOPE_MARKER_PREFIX}\n__fake__:echo:hi`;
    expect(extractPromptScope(text)).toEqual({ scope: undefined, text });
  });

  it('ignores a token longer than the scope bound instead of truncating it', () => {
    const text = `${FAKE_SCOPE_MARKER_PREFIX}${'a'.repeat(65)}\n__fake__:echo:hi`;
    expect(extractPromptScope(text)).toEqual({ scope: undefined, text });
  });

  it('only strips a leading marker that ends at a line break or the end', () => {
    expect(extractPromptScope(`${FAKE_SCOPE_MARKER_PREFIX}b plain text`)).toEqual({
      scope: undefined,
      text: `${FAKE_SCOPE_MARKER_PREFIX}b plain text`,
    });
    expect(extractPromptScope(`${FAKE_SCOPE_MARKER_PREFIX}b`)).toEqual({
      scope: 'b',
      text: '',
    });
  });

  it('leaves a marker embedded in the payload untouched', () => {
    const text = `__fake__:echo:hi ${FAKE_SCOPE_MARKER_PREFIX}b\n`;
    expect(extractPromptScope(text)).toEqual({ scope: undefined, text });
  });

  it('does not absorb a following directive when the separator is missing', () => {
    const text = `${FAKE_SCOPE_MARKER_PREFIX}abc__fake__:echo:hi`;
    expect(extractPromptScope(text)).toEqual({ scope: undefined, text });
  });
});

describe('slow scenario limits', () => {
  it('clamps a delay above MAX_SLOW_DELAY_MS to the cap', async () => {
    vi.useFakeTimers();
    try {
      const { emit, contentChunks } = recordingEmit();
      const state = createFakeLlmState();
      const pending = handleFakeLlmRequest(
        slowChatRequest(`__fake__:slow:2:${MAX_SLOW_DELAY_MS * 10}`),
        emit,
        state,
        { adminToken: TEST_ADMIN_TOKEN }
      );

      // Only the synchronous role chunk exists until the clamped sleep elapses.
      expect(contentChunks()).toBe(0);
      await vi.advanceTimersByTimeAsync(MAX_SLOW_DELAY_MS + 1);
      expect(contentChunks()).toBe(2);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops emitting content when the emit is already closed', async () => {
    const { emit, contentChunks } = recordingEmit({ alreadyClosed: true });
    await handleFakeLlmRequest(slowChatRequest('__fake__:slow:3:0'), emit, createFakeLlmState(), {
      adminToken: TEST_ADMIN_TOKEN,
    });
    expect(contentChunks()).toBe(0);
  });

  it('stops emitting content after the emit closes mid-loop', async () => {
    const { emit, contentChunks } = recordingEmit({ closeAfterContentChunks: 1 });
    await handleFakeLlmRequest(slowChatRequest('__fake__:slow:3:0'), emit, createFakeLlmState(), {
      adminToken: TEST_ADMIN_TOKEN,
    });
    expect(contentChunks()).toBe(1);
  });
});
