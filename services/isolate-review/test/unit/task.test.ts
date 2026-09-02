import { describe, expect, it, vi } from 'vitest';
import {
  generateText,
  tool,
  type FinishReason,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import {
  createTaskTool,
  MAX_TASK_CHECKPOINT_BYTES,
  MAX_TASK_CONCURRENCY,
  MAX_TASK_STEPS,
  type TaskStorage,
  type TaskOutcome,
} from '../../src/task';
import type { ReviewWorkspace } from '../../src/git';
import { READ_ONLY_GITHUB_TOOL_NAMES } from '../../src/github';
import { createKiloGatewayModel } from '../../src/model';
import { buildTaskReviewContext } from '../../src/prompt';
import type { IsolateReviewPreparation, IsolateReviewSelection } from '../../src/types';
import {
  createReviewGrepTool,
  MAX_REVIEW_GREP_LINE_BYTES,
  MAX_REVIEW_GREP_OUTPUT_BYTES,
  MAX_REVIEW_READ_OUTPUT_BYTES,
} from '../../src/workspace';

const reviewContext = 'Canonical resolved review policy and captured snapshot';
const inheritedMessage = { role: 'user', content: reviewContext } satisfies ModelMessage;

function fakeWorkspace(): ReviewWorkspace {
  return {
    readFile: vi.fn(),
    readFileBytes: vi.fn(),
    writeFile: vi.fn(),
    readDir: vi.fn(),
    rm: vi.fn(),
    glob: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
  } as unknown as ReviewWorkspace;
}

function markerTool() {
  return tool({
    description: 'test tool',
    inputSchema: z.object({}),
    execute: async () => 'test',
  });
}

function fakeGithub(): ToolSet {
  const marker = markerTool();
  return {
    ...Object.fromEntries(READ_ONLY_GITHUB_TOOL_NAMES.map(name => [name, marker])),
    submit_review: marker,
    upsert_summary: marker,
    activate_skill: marker,
    task: marker,
  };
}

function fakeStorage(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: TaskStorage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      values.set(key, value);
    },
  };
  return { storage, values };
}

function generatedResult(text = 'child finding', finishReason: FinishReason = 'stop', steps = 1) {
  const finalStep = { finishReason, toolCalls: [] };
  return {
    text,
    responseMessages: [{ role: 'assistant', content: text }],
    steps: Array.from({ length: steps }, () => finalStep),
    finalStep,
  } as unknown as Awaited<ReturnType<typeof generateText>>;
}

function makeGenerate(responseText = 'child finding') {
  const calls: Array<Parameters<typeof generateText>[0]> = [];
  const generate = vi.fn(async (args: Parameters<typeof generateText>[0]) => {
    calls.push(args);
    return generatedResult(responseText);
  });
  return { calls, generate };
}

async function executeTask(
  task: ReturnType<typeof createTaskTool>,
  input: unknown,
  abortSignal?: AbortSignal
) {
  if (!task.execute) throw new Error('task has no execute function');
  return task.execute(
    input as never,
    {
      toolCallId: 'test-task',
      messages: [],
      context: {},
      ...(abortSignal ? { abortSignal } : {}),
    } as never
  );
}

function taskOutput(result: unknown): string {
  if (!result || typeof result !== 'object' || !('output' in result)) {
    throw new Error('task result is not structured');
  }
  const output = (result as { output: unknown }).output;
  if (typeof output !== 'string') throw new Error('task result output is not text');
  return output;
}

function createTestTask(
  storage: TaskStorage,
  generate: typeof generateText,
  options: Partial<Parameters<typeof createTaskTool>[0]> = {}
): ReturnType<typeof createTaskTool> {
  return createTaskTool({
    parentSessionId: 'root-session',
    createModel: () => ({}) as LanguageModel,
    reviewContext,
    prepared: true,
    workspace: fakeWorkspace(),
    github: fakeGithub(),
    storage,
    generate,
    ...options,
  });
}

describe('review task tool', () => {
  it('rejects an unknown subagent type', async () => {
    const { storage } = fakeStorage();
    const { generate } = makeGenerate();
    const task = createTestTask(storage, generate as typeof generateText);

    await expect(
      executeTask(task, {
        description: 'bad type',
        prompt: 'inspect it',
        subagent_type: 'unknown',
      })
    ).rejects.toThrow('Unsupported subagent_type');
    expect(generate).not.toHaveBeenCalled();
  });

  it('runs a fresh read-only child with a bounded step loop', async () => {
    const { storage, values } = fakeStorage();
    const { calls, generate } = makeGenerate();
    const task = createTestTask(storage, generate as typeof generateText);

    const result = await executeTask(task, {
      description: 'Review parser',
      prompt: 'Inspect parser.ts for changed-line issues.',
      subagent_type: 'general',
      task_id: 'parser',
    });

    expect(result).toMatchObject({
      title: 'Review parser',
      metadata: {
        taskId: 'parser',
        subagentType: 'general',
        state: 'completed',
        resumed: false,
      },
    });
    expect(taskOutput(result)).toContain('<task id="parser" state="completed">');
    expect(taskOutput(result)).toContain('<task_result>');
    expect(taskOutput(result)).toContain('child finding');
    expect(calls[0]?.messages).toEqual([
      inheritedMessage,
      { role: 'user', content: 'Inspect parser.ts for changed-line issues.' },
    ]);
    expect(calls[0]?.system).toMatch(/read-only code-review specialist|task-child\.txt/);
    expect(calls[0]?.stopWhen).toEqual([expect.any(Function), expect.any(Function)]);
    expect(Object.keys(calls[0]?.tools ?? {})).toEqual([
      'read',
      'grep',
      'list',
      'find',
      ...READ_ONLY_GITHUB_TOOL_NAMES,
    ]);
    expect(calls[0]?.tools).not.toHaveProperty('submit_review');
    expect(calls[0]?.tools).not.toHaveProperty('upsert_summary');
    expect(calls[0]?.tools).not.toHaveProperty('task');
    expect(calls[0]?.tools).not.toHaveProperty('activate_skill');
    expect(values.get('task:parser')).toMatchObject({
      subagentType: 'general',
      state: 'completed',
      messages: [
        inheritedMessage,
        { role: 'user', content: 'Inspect parser.ts for changed-line issues.' },
        { role: 'assistant', content: 'child finding' },
      ],
    });
  });

  it.each(['general', 'explore'] as const)(
    'uses streaming read limits and exposes continuations in %s children',
    async subagentType => {
      const { storage } = fakeStorage();
      const { calls, generate } = makeGenerate();
      const path = '/workspace/data.csv';
      const bytes = new TextEncoder().encode('value\n'.repeat(10_000));
      const workspace = {
        ...fakeWorkspace(),
        fs: {
          readFile: vi.fn(
            async () =>
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              })
          ),
        },
      } as unknown as ReviewWorkspace;
      vi.mocked(workspace.stat).mockResolvedValue({
        path,
        name: 'data.csv',
        type: 'file',
        mimeType: 'text/csv',
        size: bytes.byteLength,
        createdAt: 0,
        updatedAt: 0,
      });
      const task = createTestTask(storage, generate as typeof generateText, { workspace });
      await executeTask(task, {
        description: 'Read a large file',
        prompt: 'Inspect the next file segment.',
        subagent_type: subagentType,
      });
      const read = calls[0]?.tools?.read;
      if (!read?.execute || !read.toModelOutput) throw new Error('Child read tool is incomplete');
      const input = { path };
      const output = await read.execute(input, {
        toolCallId: 'child-read',
        messages: [],
        context: {},
      });
      const result = z
        .object({
          content: z.string(),
          truncated: z.boolean(),
          nextOffset: z.number(),
          nextByteOffset: z.number(),
        })
        .parse(output);
      expect(result.truncated).toBe(true);
      expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(
        MAX_REVIEW_READ_OUTPUT_BYTES
      );
      expect(result.nextOffset).toBeGreaterThan(1);
      expect(await read.toModelOutput({ input, output, toolCallId: 'child-read' })).toMatchObject({
        type: 'json',
        value: { nextOffset: result.nextOffset, nextByteOffset: result.nextByteOffset },
      });
      expect(workspace.readFile).not.toHaveBeenCalled();
      expect(workspace.readFileBytes).not.toHaveBeenCalled();
    }
  );

  it.each(['general', 'explore'] as const)(
    'uses shared byte-bounded grep in %s children',
    async subagentType => {
      const { storage } = fakeStorage();
      const { calls, generate } = makeGenerate();
      const workspace = fakeWorkspace();
      const path = '/workspace/large.ts';
      const content = `needle ${'漢'.repeat(100_000)}`;
      vi.mocked(workspace.glob).mockResolvedValue([
        {
          path,
          name: 'large.ts',
          type: 'file',
          mimeType: 'text/typescript',
          size: new TextEncoder().encode(content).byteLength,
          createdAt: 0,
          updatedAt: 0,
        },
      ]);
      vi.mocked(workspace.readFile).mockResolvedValue(content);
      const task = createTestTask(storage, generate as typeof generateText, { workspace });
      await executeTask(task, {
        description: 'Search large source lines',
        prompt: 'Locate the matching source line.',
        subagent_type: subagentType,
      });
      const execute = calls[0]?.tools?.grep?.execute;
      const sharedExecute = createReviewGrepTool(workspace).execute;
      if (!execute || !sharedExecute) throw new Error('Review grep tool has no execute function');
      const input = { query: 'needle', contextLines: 10 };
      const options = { toolCallId: 'child-grep', messages: [], context: {} };
      const result = await execute(input, options);

      expect(result).toEqual(await sharedExecute(input, options));
      expect(result).toMatchObject({
        totalMatches: 1,
        truncated: true,
        truncation: { lineTextBytes: MAX_REVIEW_GREP_LINE_BYTES, truncatedLines: 1 },
        matches: [{ file: path, line: 1, context: expect.stringContaining('... (truncated)') }],
        readFollowup: expect.stringContaining('read with path, offset and limit'),
      });
      expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
        MAX_REVIEW_GREP_OUTPUT_BYTES
      );
    }
  );

  it.each(['general', 'explore'] as const)(
    'inherits immutable incremental context and shared read-only tools in fresh and resumed %s children',
    async subagentType => {
      const snapshot = {
        headSha: 'a'.repeat(40),
        baseTipSha: 'b'.repeat(40),
        mergeBaseSha: 'c'.repeat(40),
      };
      const reviewSelection = {
        requestedMode: 'incremental',
        effectiveMode: 'incremental',
        previousRunId: '00000000-0000-4000-8000-000000000001',
        previousHeadSha: 'd'.repeat(40),
        previousSummaryHash: 'e'.repeat(64),
        changedFileCount: 1,
      } satisfies IsolateReviewSelection;
      const userPrompt =
        'Canonical strict policy. REVIEW.md instructions from captured base tip.\n';
      const context = buildTaskReviewContext(
        {
          owner: 'acme',
          repo: 'widget',
          pullNumber: 42,
          kiloToken: 'offline-fixture-token',
          reviewMode: 'incremental',
          previousRunId: reviewSelection.previousRunId,
          preparation: { reviewSelection } as IsolateReviewPreparation,
          userPrompt,
        },
        snapshot
      );
      expect(context).toContain(userPrompt);
      expect(context).toContain(
        JSON.stringify({ repository: 'acme/widget', pullNumber: 42, ...snapshot, reviewSelection })
      );
      expect(context).not.toContain('offline-fixture-token');

      const { storage, values } = fakeStorage();
      const { calls, generate } = makeGenerate();
      const github = fakeGithub();
      const options = { reviewContext: context, github };
      const assignment = {
        description: 'Verify prior authorization finding',
        prompt: 'Verify the prior finding against captured current code without expanding scope.',
        subagent_type: subagentType,
        task_id: 'incremental',
      };
      const first = await executeTask(
        createTestTask(storage, generate as typeof generateText, options),
        assignment
      );
      expect(first).toMatchObject({ metadata: { state: 'completed', resumed: false } });
      values.set('task:incremental', JSON.parse(JSON.stringify(values.get('task:incremental'))));
      const followUp = 'Confirm the full current-PR RIGHT-side anchor.';
      const resumed = await executeTask(
        createTestTask(storage, generate as typeof generateText, options),
        { ...assignment, prompt: followUp }
      );
      expect(resumed).toMatchObject({ metadata: { state: 'completed', resumed: true } });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.messages).toEqual([
        { role: 'user', content: context },
        { role: 'user', content: assignment.prompt },
      ]);
      expect(calls[1]?.messages).toEqual([
        { role: 'user', content: context },
        { role: 'user', content: assignment.prompt },
        { role: 'assistant', content: 'child finding' },
        { role: 'user', content: followUp },
      ]);
      for (const call of calls) {
        expect(Object.keys(call.tools ?? {})).toEqual([
          'read',
          'grep',
          'list',
          'find',
          'pr_view',
          'pr_diff',
          'pr_comments',
          'pr_comment',
          'pr_file',
          'pr_file_patch',
          'pr_history',
          'pr_commit',
        ]);
        expect(call.tools?.pr_history).toBe(github.pr_history);
        expect(call.tools?.pr_commit).toBe(github.pr_commit);
        expect(call.tools?.pr_file).toBe(github.pr_file);
        expect(call.system).toContain('The resolved selection is immutable');
      }
    }
  );

  it('cancels in-flight child inference when the parent execution is aborted', async () => {
    const { storage, values } = fakeStorage();
    const controller = new AbortController();
    const generate = vi.fn(
      ({ abortSignal }: Parameters<typeof generateText>[0]) =>
        new Promise<Awaited<ReturnType<typeof generateText>>>((_resolve, reject) => {
          if (!abortSignal) {
            reject(new Error('parent abort signal was not forwarded'));
            return;
          }
          abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
        })
    );
    const task = createTestTask(storage, generate as typeof generateText);

    const pending = executeTask(
      task,
      {
        description: 'Review cancellation',
        prompt: 'Inspect the authorization implementation.',
        subagent_type: 'general',
        task_id: 'cancelled',
      },
      controller.signal
    );

    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal })
    );
    controller.abort(new Error('parent execution deadline exceeded'));

    const result = await pending;
    expect(result).toMatchObject({ metadata: { taskId: 'cancelled', state: 'error' } });
    expect(taskOutput(result)).toContain('parent execution deadline exceeded');
    expect(values.get('task:cancelled')).toMatchObject({
      state: 'error',
      messages: [
        inheritedMessage,
        { role: 'user', content: 'Inspect the authorization implementation.' },
      ],
    });
  });

  it('resumes a task from its stored response messages', async () => {
    const previous: ModelMessage = { role: 'assistant', content: 'previous finding' };
    const { storage } = fakeStorage({
      'task:parser': { subagentType: 'explore', messages: [previous] },
    });
    const { calls, generate } = makeGenerate('follow-up finding');
    const task = createTestTask(storage, generate as typeof generateText);

    await executeTask(task, {
      description: 'Continue parser review',
      prompt: 'Now verify the line against the current diff.',
      subagent_type: 'explore',
      task_id: 'parser',
    });

    expect(calls[0]?.messages).toEqual([
      inheritedMessage,
      previous,
      { role: 'user', content: 'Now verify the line against the current diff.' },
    ]);
    expect(calls[0]?.system).toContain('prefer narrowing the area with find and grep');
  });

  it('returns an error envelope and persists the attempted child message on failure', async () => {
    const { storage, values } = fakeStorage();
    const generate = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const task = createTestTask(storage, generate as typeof generateText);

    const result = await executeTask(task, {
      description: 'Review auth',
      prompt: 'Inspect auth.ts.',
      subagent_type: 'general',
      task_id: 'auth',
    });

    expect(result).toMatchObject({
      metadata: { taskId: 'auth', state: 'error', resumed: false, stepCount: 0 },
    });
    expect(taskOutput(result)).toContain('<task id="auth" state="error">');
    expect(taskOutput(result)).toContain('<task_error>');
    expect(taskOutput(result)).toContain('provider unavailable');
    expect(values.get('task:auth')).toMatchObject({
      subagentType: 'general',
      state: 'error',
      messages: [inheritedMessage, { role: 'user', content: 'Inspect auth.ts.' }],
    });
  });

  it('turns a completed child with no text into an explicit error', async () => {
    const { storage, values } = fakeStorage();
    const { generate } = makeGenerate('');
    const task = createTestTask(storage, generate as typeof generateText);

    const result = await executeTask(task, {
      description: 'Review empty result',
      prompt: 'Inspect the assigned files.',
      subagent_type: 'general',
      task_id: 'empty',
    });

    expect(result).toMatchObject({
      metadata: { taskId: 'empty', state: 'error', resumed: false },
    });
    expect(taskOutput(result)).toContain('<task_error>');
    expect(taskOutput(result)).toContain('without a textual result');
    expect(values.get('task:empty')).toMatchObject({ state: 'error' });
  });

  it('persists the latest step checkpoint when the provider fails afterward', async () => {
    const { storage, values } = fakeStorage();
    const generate = vi.fn(async (args: Parameters<typeof generateText>[0]) => {
      await args.onStepEnd?.({
        request: {
          messages: [{ role: 'user', content: 'Inspect auth.ts.' }],
        },
        response: {
          messages: [{ role: 'assistant', content: 'partial finding' }],
        },
        stepNumber: 0,
        finishReason: 'tool-calls',
        text: 'partial finding',
      } as never);
      throw new Error('provider interrupted');
    });
    const task = createTestTask(storage, generate as typeof generateText);

    const result = await executeTask(task, {
      description: 'Review auth',
      prompt: 'Inspect auth.ts.',
      subagent_type: 'general',
      task_id: 'checkpoint',
    });

    expect(taskOutput(result)).toContain('provider interrupted');
    expect(values.get('task:checkpoint')).toMatchObject({
      state: 'error',
      stepCount: 1,
      messages: [
        { role: 'user', content: 'Inspect auth.ts.' },
        { role: 'assistant', content: 'partial finding' },
      ],
      lastText: 'partial finding',
    });
  });

  it('marks compacted evidence incomplete without mutating active messages and refuses resume', async () => {
    const { storage, values } = fakeStorage();
    const writes: Array<{ bytes: number; value: unknown }> = [];
    const limitedStorage: TaskStorage = {
      get: <T>(key: string) => storage.get<T>(key),
      put: async <T>(key: string, value: T) => {
        const encoder = new TextEncoder();
        const bytes =
          encoder.encode(key).byteLength + encoder.encode(JSON.stringify(value)).byteLength;
        if (bytes > 2_000_000) throw new Error('Durable Object value exceeds 2 MB');
        writes.push({ bytes, value });
        await storage.put(key, value);
      },
    };
    const oversizedOutput = 'const authorization = "résumé";\n'.repeat(80_000);
    expect(new TextEncoder().encode(oversizedOutput).byteLength).toBeGreaterThan(2_000_000);

    const initialMessage = {
      role: 'user',
      content: 'Inspect the authorization implementation.',
    } satisfies ModelMessage;
    const toolCallMessage = {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'read-auth',
          toolName: 'read',
          input: { path: '/workspace/auth.ts' },
        },
      ],
    } satisfies ModelMessage;
    const oversizedToolMessage = {
      role: 'tool',
      providerOptions: { test: { source: 'message' } },
      content: [
        {
          type: 'tool-result',
          toolCallId: 'read-auth',
          toolName: 'read',
          providerOptions: { test: { source: 'result' } },
          output: {
            type: 'text',
            value: oversizedOutput,
            providerOptions: { test: { source: 'output' } },
          },
        },
      ],
    } satisfies ModelMessage;
    const partialFinding = {
      role: 'assistant',
      content: 'Authorization check is missing.',
    } satisfies ModelMessage;
    const calls: Array<Parameters<typeof generateText>[0]> = [];
    const generate = vi.fn(async (args: Parameters<typeof generateText>[0]) => {
      calls.push(args);
      if (calls.length === 1) {
        await args.onStepEnd?.({
          request: { messages: [initialMessage, toolCallMessage, oversizedToolMessage] },
          response: { messages: [partialFinding] },
          stepNumber: 0,
          finishReason: 'tool-calls',
          text: partialFinding.content,
        } as never);
        expect(oversizedToolMessage.content[0]?.output.value).toBe(oversizedOutput);
        throw new Error('provider interrupted after the file read');
      }
      return generatedResult('Confirmed missing authorization check.');
    });
    const task = createTestTask(limitedStorage, generate as typeof generateText);

    const failed = await executeTask(task, {
      description: 'Review authorization',
      prompt: initialMessage.content,
      subagent_type: 'general',
      task_id: 'large-file',
    });

    expect(failed).toMatchObject({
      metadata: {
        taskId: 'large-file',
        state: 'error',
        stepCount: 1,
        finishReason: 'tool-calls',
      },
    });
    expect(taskOutput(failed)).toContain('checkpoint context exhausted');
    expect(failed).toMatchObject({ metadata: { contextExhausted: true } });
    const checkpoint = values.get('task:large-file') as {
      messages: ModelMessage[];
      state: string;
      stepCount: number;
      finishReason: string;
      lastText: string;
    };
    expect(checkpoint).toMatchObject({
      state: 'error',
      stepCount: 1,
      finishReason: 'tool-calls',
      lastText: partialFinding.content,
    });
    expect(checkpoint.messages).toHaveLength(4);
    expect(checkpoint.messages[0]).toEqual(initialMessage);
    expect(checkpoint.messages[1]).toEqual(toolCallMessage);
    expect(checkpoint.messages[3]).toEqual(partialFinding);

    const compactedMessage = checkpoint.messages[2];
    if (compactedMessage?.role !== 'tool') throw new Error('tool checkpoint was not preserved');
    const compactedResult = compactedMessage.content[0];
    if (compactedResult?.type !== 'tool-result' || compactedResult.output.type !== 'text') {
      throw new Error('tool result checkpoint was not preserved');
    }
    expect(compactedMessage.providerOptions).toEqual({ test: { source: 'message' } });
    expect(compactedResult).toMatchObject({
      toolCallId: 'read-auth',
      toolName: 'read',
      providerOptions: { test: { source: 'result' } },
      output: { providerOptions: { test: { source: 'output' } } },
    });
    expect(compactedResult.output.value).toContain(
      '[Tool result truncated for checkpoint storage.]'
    );
    expect(compactedResult.output.value.length).toBeLessThan(40_000);
    expect(oversizedToolMessage.content[0]?.output.value).toBe(oversizedOutput);

    const resumed = await executeTask(task, {
      description: 'Resume authorization review',
      prompt: 'Confirm the missing authorization check.',
      subagent_type: 'general',
      task_id: 'large-file',
    });

    expect(resumed).toMatchObject({
      metadata: { taskId: 'large-file', state: 'error', resumed: true, contextExhausted: true },
    });
    expect(calls).toHaveLength(1);
    expect(taskOutput(resumed)).toContain('truncated evidence cannot support completion or resume');
    expect(writes.some(({ value }) => (value as { state?: string }).state === 'error')).toBe(true);
    expect(writes.every(({ bytes }) => bytes <= MAX_TASK_CHECKPOINT_BYTES)).toBe(true);
  });

  it('persists a safe error checkpoint when the latest user context cannot fit', async () => {
    const { storage, values } = fakeStorage();
    const { generate } = makeGenerate();
    const task = createTestTask(storage, generate as typeof generateText);

    const result = await executeTask(task, {
      description: 'Review oversized prompt',
      prompt: 'x'.repeat(MAX_TASK_CHECKPOINT_BYTES + 1),
      subagent_type: 'general',
      task_id: 'oversized-prompt',
    });

    const checkpointError =
      'Task checkpoint context exhausted; truncated evidence cannot support completion or resume';
    expect(taskOutput(result)).toContain(checkpointError);
    expect(generate).not.toHaveBeenCalled();
    const checkpoint = values.get('task:oversized-prompt');
    expect(checkpoint).toMatchObject({
      state: 'error',
      stepCount: 0,
      messages: [{ role: 'user', content: checkpointError }],
    });
    const encoder = new TextEncoder();
    const bytes =
      encoder.encode('task:oversized-prompt').byteLength +
      encoder.encode(JSON.stringify(checkpoint)).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX_TASK_CHECKPOINT_BYTES);
  });

  it('rejects a concurrent resume with the same task id without overwriting its checkpoint', async () => {
    const { storage, values } = fakeStorage();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const generate = vi.fn(async () => {
      await gate;
      return generatedResult();
    });
    const task = createTestTask(storage, generate as typeof generateText);
    const first = executeTask(task, {
      description: 'Review parser',
      prompt: 'Inspect parser.ts.',
      subagent_type: 'general',
      task_id: 'same-id',
    });

    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const second = await executeTask(task, {
      description: 'Resume parser',
      prompt: 'Continue the parser review.',
      subagent_type: 'general',
      task_id: 'same-id',
    });

    expect(second).toMatchObject({ metadata: { taskId: 'same-id', state: 'error' } });
    expect(taskOutput(second)).toContain('already running');

    release();
    await first;
    expect(values.get('task:same-id')).toMatchObject({ state: 'completed' });
  });

  it.each(['tool-calls', 'length', 'error', 'content-filter', 'other'] as const)(
    'does not complete partial text after %s termination',
    async finishReason => {
      const { storage, values } = fakeStorage();
      const outcomes: TaskOutcome[] = [];
      const generate = vi.fn(async () =>
        generatedResult('Provisional finding', finishReason, MAX_TASK_STEPS)
      );
      const task = createTestTask(storage, generate as typeof generateText, {
        onTaskState: outcome => {
          outcomes.push(outcome);
        },
      });
      const result = await executeTask(task, {
        description: 'Review partial analysis',
        prompt: 'Inspect the changed files.',
        subagent_type: 'general',
        task_id: 'partial',
      });
      expect(result).toMatchObject({
        metadata: { state: 'error', stepCount: MAX_TASK_STEPS, finishReason },
      });
      expect(taskOutput(result)).toContain('partial text is incomplete');
      expect(values.get('task:partial')).toMatchObject({
        state: 'error',
        lastText: 'Provisional finding',
      });
      expect(outcomes.map(outcome => outcome.state)).toEqual(['running', 'error']);
    }
  );

  it('allows a genuine clean finish at the last permitted step', async () => {
    const { storage } = fakeStorage();
    const task = createTestTask(
      storage,
      vi.fn(async () =>
        generatedResult('Verified result', 'stop', MAX_TASK_STEPS)
      ) as typeof generateText
    );
    expect(
      await executeTask(task, {
        description: 'Finish',
        prompt: 'Verify.',
        subagent_type: 'general',
      })
    ).toMatchObject({
      metadata: { state: 'completed', stepCount: MAX_TASK_STEPS, finishReason: 'stop' },
    });
  });

  it('keeps the persisted session and mode on resume and reports genuine recovery', async () => {
    const { storage, values } = fakeStorage();
    const outcomes: TaskOutcome[] = [];
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider interrupted'))
      .mockResolvedValueOnce(generatedResult('Verified after resuming'));
    const options = {
      onTaskState: (outcome: TaskOutcome) => {
        outcomes.push(outcome);
      },
    };
    const assignment = {
      description: 'Inspect auth',
      prompt: 'Verify auth.',
      subagent_type: 'explore',
      task_id: 'stable',
    };
    const failed = await executeTask(
      createTestTask(storage, generate as typeof generateText, options),
      assignment
    );
    const first = values.get('task:stable');
    const resumed = await executeTask(
      createTestTask(storage, generate as typeof generateText, options),
      assignment
    );
    expect(failed).toMatchObject({ metadata: { state: 'error', mode: 'explore' } });
    expect(resumed).toMatchObject({
      metadata: { state: 'completed', resumed: true, mode: 'explore' },
    });
    expect(values.get('task:stable')).toMatchObject({
      sessionId: (first as { sessionId: string }).sessionId,
      mode: 'explore',
      state: 'completed',
    });
    expect(new Set(outcomes.map(outcome => outcome.sessionId)).size).toBe(1);
    expect(outcomes.map(outcome => outcome.state)).toEqual([
      'running',
      'error',
      'running',
      'completed',
    ]);
    expect(outcomes.every(outcome => outcome.parentSessionId === 'root-session')).toBe(true);
    expect(outcomes[0]?.sessionId).not.toBe('root-session');
  });

  it('keeps pre-attribution checkpoints on the root legacy session', async () => {
    const { storage, values } = fakeStorage({
      'task:legacy': {
        subagentType: 'general',
        messages: [{ role: 'assistant', content: 'Earlier result' }],
      },
    });
    const { generate } = makeGenerate();
    const result = await executeTask(createTestTask(storage, generate as typeof generateText), {
      description: 'Legacy continuation',
      prompt: 'Verify again.',
      subagent_type: 'general',
      task_id: 'legacy',
    });
    expect(result).toMatchObject({
      metadata: { sessionId: 'root-session', mode: 'code', state: 'completed' },
    });
    expect((result as { metadata: unknown }).metadata).not.toHaveProperty('parentSessionId');
    expect(values.get('task:legacy')).toMatchObject({ sessionId: 'root-session', mode: 'code' });
  });

  it('refuses to turn a compacted non-tool checkpoint into a successful resume', async () => {
    const { storage, values } = fakeStorage();
    const generate = vi.fn(async (args: Parameters<typeof generateText>[0]) => {
      await args.onStepEnd?.({
        request: { messages: args.messages },
        response: {
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'reasoning',
                  text: 'r'.repeat(MAX_TASK_CHECKPOINT_BYTES),
                  providerOptions: { anthropic: { signature: 'signed' } },
                },
                { type: 'text', text: 'Partial' },
              ],
            },
          ],
        },
        stepNumber: 0,
        finishReason: 'tool-calls',
        text: 'Partial',
      } as never);
      return generatedResult('Would otherwise appear complete');
    });
    const task = createTestTask(storage, generate as typeof generateText);
    const assignment = {
      description: 'Oversized reasoning',
      prompt: 'Inspect.',
      subagent_type: 'general',
      task_id: 'reasoning-limit',
    };
    const first = await executeTask(task, assignment);
    const resumed = await executeTask(task, assignment);
    expect(first).toMatchObject({ metadata: { state: 'error', contextExhausted: true } });
    expect(resumed).toMatchObject({ metadata: { state: 'error', contextExhausted: true } });
    expect(values.get('task:reasoning-limit')).toMatchObject({
      state: 'error',
      contextExhausted: true,
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each(['context', 'persistence'] as const)(
    'stops the real SDK loop after a swallowed %s checkpoint failure',
    async failure => {
      const { storage, values } = fakeStorage();
      const outcomes: TaskOutcome[] = [];
      let writes = 0;
      const checkedStorage: TaskStorage = {
        get: key => storage.get(key),
        put: async (key, value) => {
          if (++writes === 2 && failure === 'persistence')
            throw new Error('checkpoint storage failed');
          await storage.put(key, value);
        },
      };
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json({
          id: 'chatcmpl-fixture',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Partial finding',
                ...(failure === 'context'
                  ? {
                      tool_calls: [
                        {
                          id: 'read-pr',
                          type: 'function',
                          function: { name: 'pr_view', arguments: '{}' },
                        },
                      ],
                    }
                  : {}),
              },
              finish_reason: failure === 'context' ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
      const task = createTestTask(checkedStorage, generateText, {
        createModel: session =>
          createKiloGatewayModel({
            runId: 'root-session',
            ...session,
            kiloToken: 'offline-fixture-token',
            inference: {
              modelId: 'fixture/model',
              provider: 'openai-compatible',
              thinkingEffort: null,
              variant: null,
              reasoningSupported: false,
              maxOutputTokens: 100,
            },
            fetchImpl,
          }),
        github: {
          ...fakeGithub(),
          pr_view: tool({
            inputSchema: z.object({}),
            execute: async () => 'x'.repeat(MAX_TASK_CHECKPOINT_BYTES),
          }),
        },
        onTaskState: outcome => {
          outcomes.push(outcome);
        },
      });
      const result = await executeTask(task, {
        description: 'Checkpoint failure',
        prompt: 'Inspect.',
        subagent_type: 'general',
        task_id: 'failed-checkpoint',
      });
      expect(result).toMatchObject({ metadata: { state: 'error', stepCount: 1 } });
      expect(values.get('task:failed-checkpoint')).toMatchObject({
        state: 'error',
        lastText: 'Partial finding',
        contextExhausted: failure === 'context',
      });
      expect(taskOutput(result)).toContain(
        failure === 'context' ? 'checkpoint context exhausted' : 'checkpoint storage failed'
      );
      expect(outcomes.map(outcome => outcome.state)).toEqual(['running', 'error']);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  );

  it('preserves signed reasoning and provider metadata across persisted continuation', async () => {
    const reasoning: ModelMessage = {
      role: 'assistant',
      providerOptions: {
        openrouter: {
          reasoning_details: [{ type: 'reasoning.encrypted', data: 'encrypted', id: 'r1' }],
        },
      },
      content: [
        {
          type: 'reasoning',
          text: '',
          providerOptions: { anthropic: { signature: 'signature', redactedData: 'redacted' } },
        },
        { type: 'text', text: 'Partial verification' },
      ],
    };
    const { storage, values } = fakeStorage();
    const generate = vi.fn(async (args: Parameters<typeof generateText>[0]) => {
      await args.onStepEnd?.({
        request: { messages: args.messages },
        response: { messages: [reasoning] },
        stepNumber: 0,
        finishReason: 'tool-calls',
        text: 'Partial verification',
      } as never);
      throw new Error('interrupted');
    });
    const assignment = {
      description: 'Signed continuation',
      prompt: 'Verify.',
      subagent_type: 'general',
      task_id: 'signed',
    };
    await executeTask(createTestTask(storage, generate as typeof generateText), assignment);
    values.set('task:signed', JSON.parse(JSON.stringify(values.get('task:signed'))));
    const resumedGenerate = makeGenerate('Confirmed');
    const result = await executeTask(
      createTestTask(storage, resumedGenerate.generate as typeof generateText),
      assignment
    );
    expect(result).toMatchObject({ metadata: { state: 'completed', resumed: true } });
    expect(resumedGenerate.calls[0]?.messages).toContainEqual(reasoning);
    expect(values.get('task:signed')).toMatchObject({
      messages: expect.arrayContaining([reasoning]),
    });
  });

  it('fails children beyond the in-flight concurrency cap', async () => {
    const { storage } = fakeStorage();
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => {
      resolveStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let calls = 0;
    const generate = vi.fn(async () => {
      calls += 1;
      if (calls === MAX_TASK_CONCURRENCY) resolveStarted();
      await gate;
      return generatedResult();
    });
    const task = createTestTask(storage, generate as typeof generateText);
    const pending = Array.from({ length: MAX_TASK_CONCURRENCY }, (_, index) =>
      executeTask(task, {
        description: `Review area ${index}`,
        prompt: `Inspect area ${index}.`,
        subagent_type: 'general',
        task_id: `area-${index}`,
      })
    );

    await started;
    const [seventh, eighth] = await Promise.all([
      executeTask(task, {
        description: 'Review area 6',
        prompt: 'Inspect area 6.',
        subagent_type: 'general',
        task_id: 'area-6',
      }),
      executeTask(task, {
        description: 'Review area 7',
        prompt: 'Inspect area 7.',
        subagent_type: 'general',
        task_id: 'area-7',
      }),
    ]);

    expect(taskOutput(seventh)).toContain('task concurrency limit reached');
    expect(taskOutput(eighth)).toContain('task concurrency limit reached');

    release();
    await Promise.all(pending);
  });
});
