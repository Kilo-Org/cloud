import type { PreparationAttempt, SessionCommit } from '@kilocode/cloud-agent-sdk';
import type { AssistantMessage } from '@/types/opencode.gen';
import type { Part, StoredMessage, ToolPart, TextPart } from '../types';
import { createCloudMessageProjector } from './message-projection';
import { cloudRuntimeGates } from './presentation-types';

function assistant(
  id: string,
  overrides: Partial<AssistantMessage> = {},
  parts: Part[] = []
): StoredMessage & { info: AssistantMessage } {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 'ses-fixture',
      parentID: 'user-1',
      time: { created: 1, completed: 2 },
      modelID: 'fixture',
      providerID: 'fixture',
      mode: 'code',
      agent: 'code',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...overrides,
    },
    parts,
  };
}
function text(id: string, messageID: string, value = id): TextPart {
  return { type: 'text', id, sessionID: 'ses-fixture', messageID, text: value };
}
function tool(status: ToolPart['state']['status']): ToolPart {
  const input = { nested: { paths: ['a.ts', 'b.ts'] } };
  return {
    id: 'part-tool',
    type: 'tool',
    sessionID: 'ses-fixture',
    messageID: 'a',
    callID: 'original-call',
    tool: 'unknown_mcp',
    state:
      status === 'completed'
        ? {
            status,
            input,
            output: 'result',
            metadata: { structured: { rows: [1, 2] } },
            title: 'Tool',
            time: { start: 1, end: 2 },
          }
        : status === 'error'
          ? { status, input, error: 'failed', time: { start: 1, end: 2 } }
          : status === 'pending'
            ? { status, input, raw: '{"nested":' }
            : { status, input, time: { start: 1 } },
  };
}

describe('Cloud message projection', () => {
  it('preserves Cloud grouping, source anchors, order and timestamps without mutating sources', () => {
    const a = assistant('a', {}, [text('p1', 'a')]);
    const b = assistant('b', { time: { created: 3, completed: 4 } }, [text('p2', 'b')]);
    Object.freeze(a.parts);
    Object.freeze(a);
    const [row] = createCloudMessageProjector()({ messages: [a, b], isStreaming: false });
    expect(row.message.id).toBe('a');
    expect(row.message.createdAt).toEqual(new Date(3));
    expect(row.presentation.messageIds).toEqual(['a', 'b']);
    expect(row.presentation.parts.map(part => [part.id, part.messageId])).toEqual([
      ['p1', 'a'],
      ['p2', 'b'],
    ]);
    expect(row.presentation.sources).toEqual([a, b]);
    expect(a.parts).toHaveLength(1);
  });

  it('retains stable rows and parts during streaming, and invalidates only changed metadata', () => {
    const project = createCloudMessageProjector();
    const a = assistant('a', {}, [text('p1', 'a')]);
    const b = assistant('b', { parentID: 'user-2', time: { created: 3 } }, [text('p2', 'b')]);
    const initial = project({ messages: [a, b], isStreaming: true });
    expect(project({ messages: [a, b], isStreaming: true })[0]).toBe(initial[0]);
    const updated = { ...b, parts: [text('p2', 'b', 'streamed')] };
    const streamed = project({ messages: [a, updated], isStreaming: true });
    expect(streamed[0]).toBe(initial[0]);
    expect(streamed[1].message.status).toEqual({ type: 'running' });
    const delivery = { status: 'queued' } as const;
    const changed = project({
      messages: [a, updated],
      isStreaming: true,
      pendingMessages: new Map([['a', delivery]]),
    });
    expect(changed[0]).not.toBe(streamed[0]);
    expect(changed[0].presentation.deliveryState).toBe(delivery);
    expect(changed[0].message.content[0]).toBe(streamed[0].message.content[0]);
    expect(changed[1]).toBe(streamed[1]);
  });

  it('keeps preparations and commits as decorations and grouping barriers', () => {
    const a = assistant('a');
    const b = assistant('b');
    const commit: SessionCommit = {
      commitHash: 'abc',
      commitMessage: 'Fixture',
      messageId: 'a',
      userMessageId: 'user-1',
      committedAt: '2026-10-28T00:00:00Z',
      pushStatus: 'pushed',
    };
    const preparation: PreparationAttempt = {
      id: 'prepare-1',
      triggerMessageId: 'b',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      revision: 1,
      steps: [],
    };
    const rows = createCloudMessageProjector()({
      messages: [a, b],
      isStreaming: false,
      commitsAfterMessage: new Map([['a', [commit]]]),
      preparationByMessageId: new Map([['b', [preparation]]]),
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].presentation.commits).toEqual([commit]);
    expect(rows[1].presentation.preparations).toEqual([preparation]);
    expect(rows.map(row => row.message.content)).toEqual([[], []]);
  });

  it.each(['pending', 'running', 'completed', 'error'] as const)(
    'preserves %s tool input, original identity and structured results',
    status => {
      const part = tool(status);
      const [row] = createCloudMessageProjector()({
        messages: [assistant('a', {}, [part])],
        isStreaming: true,
      });
      expect(row.presentation.parts[0].source).toBe(part);
      expect(row.presentation.parts[0].toolCallId).toBe('original-call');
      expect(row.message.content[0]).toMatchObject({
        type: 'tool-call',
        toolCallId: 'original-call',
        toolName: 'unknown_mcp',
      });
      if (status === 'completed')
        expect(row.message.content[0]).toMatchObject({
          result: { output: 'result', metadata: { structured: { rows: [1, 2] } } },
        });
      if (status === 'error')
        expect(row.message.content[0]).toMatchObject({
          isError: true,
          result: { error: 'failed' },
        });
    }
  );

  it('keeps hidden records available and preserves custom content and stripped files', () => {
    const parts: Part[] = [
      { id: 'step', type: 'step-start', sessionID: 'ses-fixture', messageID: 'a' },
      { ...tool('completed'), id: 'hidden', tool: 'plan_enter' },
      {
        id: 'file',
        type: 'file',
        sessionID: 'ses-fixture',
        messageID: 'a',
        mime: 'image/png',
        url: '',
        filename: 'fixture.png',
      },
      {
        id: 'subtask',
        type: 'subtask',
        sessionID: 'ses-fixture',
        messageID: 'a',
        prompt: 'Inspect',
        description: 'Task',
        agent: 'code',
      },
    ];
    const [row] = createCloudMessageProjector()({
      messages: [assistant('a', {}, parts)],
      isStreaming: false,
    });
    expect(row.presentation.parts.map(part => part.source)).toEqual(parts);
    expect(row.message.content).toEqual([
      { type: 'data', id: 'file', name: 'cloud-part', data: parts[2] },
      { type: 'data', id: 'subtask', name: 'cloud-part', data: parts[3] },
    ]);
  });

  it('maps failures, cancellation and read-only replay without inventing running state', () => {
    const project = createCloudMessageProjector();
    const aborted = assistant('a', {
      error: { name: 'MessageAbortedError', data: { message: 'Cancelled' } },
    });
    expect(project({ messages: [aborted], isStreaming: true })[0].message.status).toEqual({
      type: 'incomplete',
      reason: 'cancelled',
    });
    const legacyInterrupt = assistant('legacy-abort', {
      error: { name: 'UnknownError', data: { message: 'user_interrupt' } },
    });
    expect(project({ messages: [legacyInterrupt], isStreaming: true })[0].message.status).toEqual({
      type: 'incomplete',
      reason: 'cancelled',
    });
    const failed = assistant('failure', {
      error: { name: 'UnknownError', data: { message: 'Provider failed' } },
    });
    expect(project({ messages: [failed], isStreaming: true })[0].message.status).toEqual({
      type: 'incomplete',
      reason: 'error',
    });
    const incomplete = assistant('b', { time: { created: 3 } });
    expect(project({ messages: [incomplete], isStreaming: false })[0].message.status).toEqual({
      type: 'complete',
      reason: 'stop',
    });
    expect(
      cloudRuntimeGates({
        isLoading: true,
        isRunning: false,
        isReadOnly: true,
        isSendDisabled: false,
        canInterrupt: true,
      })
    ).toEqual({
      isLoading: true,
      isRunning: false,
      isDisabled: true,
      isSendDisabled: true,
      canCancel: false,
    });
    expect(
      cloudRuntimeGates({
        isLoading: false,
        isRunning: true,
        isReadOnly: false,
        isSendDisabled: true,
        canInterrupt: true,
      })
    ).toMatchObject({ isDisabled: false, isSendDisabled: true, canCancel: true });
  });
});

describe('Cloud projection transitions and replay', () => {
  const user = (id: string, parts: Part[] = []): StoredMessage => ({
    info: {
      id,
      role: 'user',
      sessionID: 'ses-fixture',
      time: { created: 0 },
      agent: 'code',
      model: { providerID: 'fixture', modelID: 'fixture' },
    },
    parts,
  });

  it('projects text and reasoning lifecycle through one projector and preserves unchanged part identity', () => {
    const project = createCloudMessageProjector();
    const stable = text('stable', 'a', 'Stable');
    const reasoning: Part = {
      id: 'reason',
      type: 'reasoning',
      messageID: 'a',
      sessionID: 'ses-fixture',
      text: 'Inspecting',
      time: { start: 1 },
    };
    const first = assistant('a', { time: { created: 1 } }, [
      stable,
      reasoning,
      text('stream', 'a', 'First'),
    ]);
    const initial = project({ messages: [first], isStreaming: true })[0];
    const updated = {
      ...first,
      parts: [
        stable,
        { ...reasoning, text: 'Inspecting the upload flow' },
        { ...text('stream', 'a', 'First second'), time: { start: 1 } },
      ],
    };
    const streaming = project({ messages: [updated], isStreaming: true })[0];
    expect(streaming.message.content).toEqual([
      { type: 'text', id: 'stable', text: 'Stable', status: { type: 'complete' } },
      {
        type: 'reasoning',
        id: 'reason',
        text: 'Inspecting the upload flow',
        status: { type: 'running' },
      },
      { type: 'text', id: 'stream', text: 'First second', status: { type: 'running' } },
    ]);
    expect(streaming.message.content[0]).toBe(initial.message.content[0]);
    const completed = project({
      messages: [
        {
          ...updated,
          info: { ...first.info, time: { created: 1, completed: 4 } },
          parts: updated.parts.map(part =>
            part.type === 'reasoning' || part.type === 'text'
              ? { ...part, time: { start: 1, end: 4 } }
              : part
          ),
        },
      ],
      isStreaming: false,
    })[0];
    expect(completed.message.status).toEqual({ type: 'complete', reason: 'stop' });
    expect(completed.message.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'stream',
          text: 'First second',
          status: { type: 'complete' },
        }),
        expect.objectContaining({
          id: 'reason',
          text: 'Inspecting the upload flow',
          status: { type: 'complete' },
        }),
      ])
    );
  });

  it('projects pending, running, completed and failed tool updates without losing source identity', () => {
    const project = createCloudMessageProjector();
    for (const status of ['pending', 'running', 'completed', 'error'] as const) {
      const part = tool(status);
      const row = project({
        messages: [assistant('a', { time: { created: 1 } }, [part])],
        isStreaming: true,
      })[0];
      expect(row.presentation.parts[0].source).toBe(part);
      expect(row.presentation.parts[0].toolCallId).toBe('original-call');
      const content = row.message.content[0];
      expect(content).toMatchObject({
        type: 'tool-call',
        toolCallId: 'original-call',
        toolName: 'unknown_mcp',
      });
      if (status === 'pending') expect(content).toMatchObject({ argsText: '{"nested":' });
      else expect(content).toMatchObject({ argsText: '{"nested":{"paths":["a.ts","b.ts"]}}' });
      if (status === 'completed')
        expect(content).toMatchObject({
          result: { output: 'result', metadata: { structured: { rows: [1, 2] } } },
        });
      else if (status === 'error')
        expect(content).toMatchObject({ isError: true, result: { error: 'failed' } });
      else expect(content).not.toHaveProperty('result');
    }
  });

  it('invalidates replaced decorations and sending state without replacing unchanged content', () => {
    const project = createCloudMessageProjector();
    const source = user('user', [text('user-text', 'user', 'Review')]);
    const preparation: PreparationAttempt = {
      id: 'prepare',
      triggerMessageId: 'user',
      status: 'running',
      startedAt: 1,
      revision: 1,
      steps: [],
    };
    const commit: SessionCommit = {
      commitHash: 'abc',
      commitMessage: 'Initial',
      messageId: 'user',
      userMessageId: 'user',
      committedAt: '2026-10-28T00:00:00Z',
      pushStatus: 'unknown',
    };
    const initial = project({
      messages: [source],
      isStreaming: false,
      preparationByMessageId: new Map([['user', [preparation]]]),
      commitsAfterMessage: new Map([['user', [commit]]]),
    })[0];
    const updatedPreparation = {
      ...preparation,
      status: 'completed' as const,
      completedAt: 2,
      revision: 2,
    };
    const updatedCommit = { ...commit, pushStatus: 'pushed' as const };
    const decorations = {
      preparationByMessageId: new Map([['user', [updatedPreparation]]]),
      commitsAfterMessage: new Map([['user', [updatedCommit]]]),
    };
    const updated = project({
      messages: [source],
      isStreaming: false,
      ...decorations,
      sendingMessageIds: new Set(['user']),
    })[0];
    expect(updated).not.toBe(initial);
    expect(updated.presentation.preparations[0]).toBe(updatedPreparation);
    expect(updated.presentation.commits[0]).toBe(updatedCommit);
    expect(updated.presentation.isSending).toBe(true);
    expect(updated.message.content[0]).toBe(initial.message.content[0]);
    const settled = project({ messages: [source], isStreaming: false, ...decorations })[0];
    expect(settled.presentation.isSending).toBe(false);
    expect(settled).not.toBe(updated);
  });

  it('reconciles user delivery and immutable replay with stable ordered IDs and compaction/review metadata', () => {
    const project = createCloudMessageProjector();
    const review = user('review', [
      text('review-text', 'review', '<worktree-review>Review saved changes</worktree-review>'),
    ]);
    const compaction = user('compact', [
      {
        id: 'compact-part',
        type: 'compaction',
        sessionID: 'ses-fixture',
        messageID: 'compact',
        auto: true,
      },
    ]);
    const reply = assistant('reply', { parentID: 'review' }, [
      text('reply-text', 'reply', 'Reviewed'),
    ]);
    const sources = [review, reply, compaction];
    const sending = project({
      messages: sources,
      isStreaming: false,
      sendingMessageIds: new Set(['review']),
    });
    const queued = project({
      messages: sources,
      isStreaming: false,
      pendingMessages: new Map([['review', { status: 'queued' }]]),
    });
    expect(queued[0].presentation.isSending).toBe(false);
    expect(queued[0].presentation.deliveryState).toEqual({ status: 'queued' });
    expect(queued[1]).toBe(sending[1]);
    const failed = project({
      messages: sources,
      isStreaming: false,
      pendingMessages: new Map([
        ['review', { status: 'failed', error: 'Retry', reason: 'exhausted' }],
      ]),
    });
    expect(failed[0].presentation.deliveryState).toMatchObject({
      status: 'failed',
      reason: 'exhausted',
    });
    const replay = project({ messages: JSON.parse(JSON.stringify(sources)), isStreaming: false });
    expect(replay.map(row => row.message.id)).toEqual(['review', 'reply', 'compact']);
    expect(replay.flatMap(row => row.presentation.messageIds)).toEqual([
      'review',
      'reply',
      'compact',
    ]);
    expect(replay[0].presentation.deliveryState).toBeUndefined();
    expect(replay[0].presentation.parts[0].source).toEqual(review.parts[0]);
    expect(replay[2].presentation.parts[0].source).toEqual(compaction.parts[0]);
    expect(replay[2].message.content).toEqual([
      { type: 'data', id: 'compact-part', name: 'cloud-part', data: compaction.parts[0] },
    ]);
  });
});

it('invalidates preparation and commit replacements independently', () => {
  const project = createCloudMessageProjector();
  const source = assistant('a', {}, [text('text', 'a', 'Unchanged')]);
  const preparation: PreparationAttempt = {
    id: 'prepare',
    triggerMessageId: 'a',
    status: 'running',
    startedAt: 1,
    revision: 1,
    steps: [],
  };
  const commit: SessionCommit = {
    commitHash: 'abc',
    commitMessage: 'Initial',
    messageId: 'a',
    userMessageId: 'user-1',
    committedAt: '2026-10-28T00:00:00Z',
    pushStatus: 'unknown',
  };
  const preparationByMessageId = new Map([['a', [preparation]]]);
  const commitsAfterMessage = new Map([['a', [commit]]]);
  const unaffected = assistant('unaffected', { parentID: 'other-turn' }, [
    text('other', 'unaffected', 'Other'),
  ]);
  const fixed = {
    messages: [source, unaffected],
    isStreaming: false,
    preparationByMessageId,
    commitsAfterMessage,
  };
  const firstRows = project(fixed);
  const initial = firstRows[0];
  const preparations = new Map([['a', [{ ...preparation, revision: 2, steps: [] }]]]);
  const prepInput = { ...fixed, preparationByMessageId: preparations };
  const prepRows = project(prepInput);
  const prepOnly = prepRows[0];
  expect(prepRows[1]).toBe(firstRows[1]);
  expect(project(prepInput)[0]).toBe(prepOnly);
  expect(prepOnly).not.toBe(initial);
  expect(prepOnly.presentation.preparations[0].revision).toBe(2);
  expect(prepOnly.presentation.commits).toBe(initial.presentation.commits);
  expect(prepOnly.message.content[0]).toBe(initial.message.content[0]);
  const commits = new Map([['a', [{ ...commit, pushStatus: 'pushed' as const }]]]);
  const commitInput = {
    ...fixed,
    preparationByMessageId: preparations,
    commitsAfterMessage: commits,
  };
  const commitRows = project(commitInput);
  const commitOnly = commitRows[0];
  expect(commitRows[1]).toBe(firstRows[1]);
  expect(project(commitInput)[0]).toBe(commitOnly);
  expect(commitOnly).not.toBe(prepOnly);
  expect(commitOnly.presentation.commits[0].pushStatus).toBe('pushed');
  expect(commitOnly.presentation.preparations).toBe(prepOnly.presentation.preparations);
  expect(commitOnly.message.content[0]).toBe(prepOnly.message.content[0]);
});
