import { enforceRowSizeLimit, sanitizeMessage, StreamAccumulator } from 'agents/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import { ReviewIsolate } from '../../src/review-isolate';
import { projectReviewTranscript } from '../../src/transcript';
import type { Env, RunState } from '../../src/types';

const lifecycle = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  getMessages: vi.fn<() => Promise<UIMessage[]>>(),
  getState: vi.fn<(key: string) => Promise<RunState | undefined>>(),
  putState: vi.fn<() => Promise<void>>(),
  migrate: vi.fn<() => Promise<void>>(),
}));

vi.mock('@cloudflare/think', () => ({
  Think: class {
    constructor(
      readonly ctx: DurableObjectState,
      readonly env: Env
    ) {}

    __unsafe_ensureInitialized = lifecycle.initialize;
    getMessages = lifecycle.getMessages;
  },
}));
vi.mock('@cloudflare/computer', () => ({ Workspace: class {} }));
vi.mock('@cloudflare/computer/git', () => ({ createGitClient: () => ({}) }));
vi.mock('../../src/persistence', () => ({
  createReviewPersistence: () => ({
    persistence: { get: lifecycle.getState, put: lifecycle.putState },
    migrate: lifecycle.migrate,
  }),
}));
vi.mock('../../src/prompt', () => ({ DEFAULT_MODEL: 'fixture/unused-default' }));
vi.mock('../../src/prompt/skills', () => ({ ISOLATE_REVIEW_SKILLS: {} }));

describe('ReviewIsolate transcript reads', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lifecycle.initialize.mockResolvedValue(undefined);
    lifecycle.getMessages.mockResolvedValue([]);
    lifecycle.putState.mockResolvedValue(undefined);
    lifecycle.migrate.mockResolvedValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Network disabled in transcript units')
    );
  });
  afterEach(() => vi.restoreAllMocks());

  function reviewState(queued = false): RunState {
    const runId = crypto.randomUUID();
    const state: RunState = {
      runId,
      status: 'error',
      terminationReason: 'required_context_incomplete',
      input: {
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        userId: 'review-owner',
        kiloToken: '',
      },
    };
    if (queued) {
      state.queued = {
        identity: {
          reviewId: crypto.randomUUID(),
          attemptId: runId,
          generation: crypto.randomUUID(),
          organizationId: crypto.randomUUID(),
          integrationId: crypto.randomUUID(),
          executionUserId: 'review-owner',
          target: { host: 'github.com', repoFullName: 'acme/widget', prNumber: 42 },
          snapshot: {
            headSha: 'a'.repeat(40),
            baseTipSha: 'b'.repeat(40),
            mergeBaseSha: 'c'.repeat(40),
          },
        },
        callback: { url: 'https://callback.offline.invalid/status', token: 'd'.repeat(64) },
        maintenanceScheduleId: 'maintenance',
        admitted: true,
        cancellationRequested: false,
        operations: [],
        safety: {
          sequence: 1,
          execution: 'running',
          cancellationRequested: false,
          publication: 'not_started',
          quiescent: false,
          observedAt: '2026-09-02T00:00:00.000Z',
        },
        fenceReleased: false,
        acknowledgedSequence: 0,
        cleaned: false,
      };
    }
    return state;
  }

  async function coldIsolate(state?: RunState) {
    lifecycle.getState.mockImplementation(async () => structuredClone(state));
    const startup: Promise<unknown>[] = [];
    const ctx = {
      storage: {},
      blockConcurrencyWhile: <T>(callback: () => Promise<T>) => {
        const pending = callback();
        startup.push(pending);
        return pending;
      },
    } as DurableObjectState;
    const instance = new ReviewIsolate(ctx, {} as Env);
    await Promise.all(startup);
    lifecycle.getState.mockClear();
    return instance;
  }

  it.each([false, true])(
    'awaits cold hydration without rewriting run state (queued=%s)',
    async queued => {
      const state = reviewState(queued);
      const instance = await coldIsolate(state);
      const started = Promise.withResolvers<void>();
      const hydrated = Promise.withResolvers<void>();
      const messages: UIMessage[] = [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-pr_view',
              toolCallId: 'call-1',
              state: 'output-error',
              input: { offset: 1, bodyHash: '' },
              errorText: 'PR description changed or continuation lacks its body hash',
            },
          ],
        },
      ];
      lifecycle.initialize.mockImplementation(async () => {
        started.resolve();
        await hydrated.promise;
        lifecycle.getMessages.mockResolvedValue(messages);
      });
      const pending = instance.getTranscript('review-owner');
      try {
        expect(
          await Promise.race([
            started.promise.then(() => 'initializing'),
            pending.then(() => 'read'),
          ])
        ).toBe('initializing');
        expect(lifecycle.getState).toHaveBeenCalledWith('runState');
        expect(lifecycle.getMessages).not.toHaveBeenCalled();
      } finally {
        hydrated.resolve();
      }
      expect(await pending).toEqual({ runId: state.runId, ...projectReviewTranscript(messages) });
      expect(lifecycle.initialize).toHaveBeenCalledOnce();
      expect(lifecycle.getMessages).toHaveBeenCalledOnce();
      expect(lifecycle.putState).not.toHaveBeenCalled();
    }
  );

  it.each(['missing', 'terminal', 'queued-terminal'] as const)(
    'rejects unauthorized %s reads without initialization, history access, or state writes',
    async kind => {
      const state = kind === 'missing' ? undefined : reviewState(kind === 'queued-terminal');
      const instance = await coldIsolate(state);
      expect(await instance.getTranscript('another-user')).toBeNull();
      expect(lifecycle.initialize).not.toHaveBeenCalled();
      expect(lifecycle.getMessages).not.toHaveBeenCalled();
      expect(lifecycle.putState).not.toHaveBeenCalled();
    }
  );

  it('propagates initialization failure instead of reporting an empty transcript', async () => {
    const instance = await coldIsolate(reviewState());
    lifecycle.initialize.mockRejectedValueOnce(new Error('Fixture hydration failed'));
    await expect(instance.getTranscript('review-owner')).rejects.toThrow(
      'Fixture hydration failed'
    );
    expect(lifecycle.getMessages).not.toHaveBeenCalled();
    expect(lifecycle.putState).not.toHaveBeenCalled();
  });
});

describe('projectReviewTranscript', () => {
  it.each(['available', 'error'] as const)(
    'preserves installed Think accumulator tool input and output-%s after serialization',
    state => {
      const accumulator = new StreamAccumulator({ messageId: 'assistant-1' });
      const input = { offset: 0, bodyHash: '' };
      const output = { body: 'x'.repeat(50), bodyHash: 'a'.repeat(64), nextOffset: null };
      const errorText = 'PR description changed or continuation lacks its body hash';
      accumulator.applyChunk({
        type: 'tool-input-start',
        toolCallId: 'call-1',
        toolName: 'pr_view',
      });
      accumulator.applyChunk({
        type: 'tool-input-delta',
        toolCallId: 'call-1',
        inputTextDelta: JSON.stringify(input),
      });
      accumulator.applyChunk({
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'pr_view',
        input,
      });
      accumulator.applyChunk(
        state === 'available'
          ? { type: 'tool-output-available', toolCallId: 'call-1', output }
          : { type: 'tool-output-error', toolCallId: 'call-1', errorText }
      );
      const persisted = JSON.parse(
        JSON.stringify(enforceRowSizeLimit(sanitizeMessage(accumulator.toMessage())))
      ) as UIMessage;

      expect(projectReviewTranscript([persisted]).toolCalls).toEqual([
        {
          messageId: 'assistant-1',
          toolCallId: 'call-1',
          toolName: 'pr_view',
          state: `output-${state}`,
          input,
          ...(state === 'available' ? { output } : { errorText }),
        },
      ]);
    }
  );

  it('extracts text messages and tool calls from UIMessages', () => {
    const uiMessages = [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Review this PR' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Looking at the diff. ' },
          {
            type: 'tool-read',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { path: 'src/foo.ts' },
            output: 'export const foo = 1;',
          },
          { type: 'text', text: 'One finding.' },
        ],
      },
    ] as UIMessage[];

    expect(projectReviewTranscript(uiMessages)).toEqual({
      messages: [
        { id: 'user-1', role: 'user', text: 'Review this PR' },
        { id: 'assistant-1', role: 'assistant', text: 'Looking at the diff. One finding.' },
      ],
      toolCalls: [
        {
          messageId: 'assistant-1',
          toolCallId: 'call-1',
          toolName: 'read',
          state: 'output-available',
          input: { path: 'src/foo.ts' },
          output: 'export const foo = 1;',
        },
      ],
    });
  });

  it('keeps failed tool calls and dynamic tools', () => {
    const uiMessages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'pr_diff',
            toolCallId: 'call-2',
            state: 'output-error',
            input: { pullNumber: 1 },
            errorText: 'GitHub API returned 404',
          },
        ],
      },
    ] as UIMessage[];

    expect(projectReviewTranscript(uiMessages).toolCalls).toEqual([
      {
        messageId: 'assistant-1',
        toolCallId: 'call-2',
        toolName: 'pr_diff',
        state: 'output-error',
        input: { pullNumber: 1 },
        errorText: 'GitHub API returned 404',
      },
    ]);
  });
});
