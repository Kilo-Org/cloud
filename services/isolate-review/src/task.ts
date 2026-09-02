import { createWorkspaceTools } from '@cloudflare/think/tools/workspace';
import {
  generateText,
  modelMessageSchema,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import { READ_ONLY_GITHUB_TOOL_NAMES } from './github';
import type { ReviewWorkspace } from './git';
import { buildChildSystemPrompt } from './prompt';
import { createReviewGrepTool, createReviewReadTool } from './workspace';

export const MAX_TASK_CONCURRENCY = 6;
export const MAX_TASK_STEPS = 12;
export const MAX_TASK_CHECKPOINT_BYTES = 1_500_000;

const MAX_TASK_TOOL_RESULT_CHARACTERS = 32_768;
const CONTEXT_EXHAUSTED =
  'Task checkpoint context exhausted; truncated evidence cannot support completion or resume';
const TRUNCATED_TOOL_RESULT = '[Tool result truncated for checkpoint storage.]';
const subagentTypeSchema = z.enum(['general', 'explore']);
const taskInputSchema = z.object({
  description: z.string(),
  prompt: z.string(),
  subagent_type: subagentTypeSchema,
  task_id: z.string().min(1).max(256).optional(),
});

type SubagentType = z.infer<typeof subagentTypeSchema>;
type TaskInput = z.infer<typeof taskInputSchema>;
export type TaskState = 'running' | 'completed' | 'error';
type TerminalTaskState = Exclude<TaskState, 'running'>;

export type TaskSession = {
  taskId: string;
  sessionId: string;
  parentSessionId?: string;
  mode: 'code' | 'general' | 'explore';
};

export type TaskMetadata = TaskSession & {
  subagentType: SubagentType;
  state: TerminalTaskState;
  resumed: boolean;
  stepCount: number;
  finishReason?: string;
  contextExhausted?: boolean;
};

export type TaskOutcome = Omit<TaskMetadata, 'state'> & { state: TaskState };

export type TaskResult = {
  title: string;
  metadata: TaskMetadata;
  output: string;
};

export type TaskStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

const storedTaskSchema = z
  .object({
    subagentType: subagentTypeSchema,
    sessionId: z.string().min(1).max(256).optional(),
    mode: z.enum(['code', 'general', 'explore']).optional(),
    messages: z.array(modelMessageSchema),
    state: z.enum(['running', 'completed', 'error']).optional(),
    stepCount: z.number().int().nonnegative().optional(),
    finishReason: z.string().optional(),
    lastText: z.string().optional(),
    contextExhausted: z.boolean().optional(),
  })
  .refine(value => (value.sessionId === undefined) === (value.mode === undefined), {
    message: 'Task session identity is incomplete',
  });

type StoredTask = z.infer<typeof storedTaskSchema>;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function taskResult(description: string, result: string, metadata: TaskMetadata): TaskResult {
  const tag = metadata.state === 'error' ? 'task_error' : 'task_result';
  return {
    title: description,
    metadata,
    output: [
      `<task id="${escapeXml(metadata.taskId)}" state="${metadata.state}">`,
      `<summary>${escapeXml(description)}</summary>`,
      `<${tag}>`,
      escapeXml(result),
      `</${tag}>`,
      '</task>',
    ].join('\n'),
  };
}

function lastAssistantText(messages: ModelMessage[]): string {
  const assistant = [...messages].reverse().find(message => message.role === 'assistant');
  if (!assistant) return '';
  if (typeof assistant.content === 'string') return assistant.content;
  return assistant.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');
}

function pickTools(tools: ToolSet): ToolSet {
  const selected: ToolSet = {};
  for (const name of READ_ONLY_GITHUB_TOOL_NAMES) {
    if (tools[name]) selected[name] = tools[name];
  }
  return selected;
}

async function persistTask(
  storage: TaskStorage,
  key: string,
  value: StoredTask
): Promise<{ error?: string; contextExhausted: boolean }> {
  let contextExhausted = value.contextExhausted === true;
  try {
    const encoder = new TextEncoder();
    const keySize = encoder.encode(key).byteLength;
    const checkpointSize = (checkpoint: StoredTask) =>
      keySize + encoder.encode(JSON.stringify(checkpoint)).byteLength;
    let checkpoint = value;

    if (checkpointSize(checkpoint) > MAX_TASK_CHECKPOINT_BYTES) {
      contextExhausted = true;
      checkpoint = {
        ...value,
        state: 'error',
        contextExhausted,
        messages: value.messages.map(message => {
          if (message.role !== 'tool') return message;
          return {
            ...message,
            content: message.content.map(part => {
              if (part.type !== 'tool-result') return part;
              const output = part.output;
              const serialized = JSON.stringify(output);
              if (encoder.encode(serialized).byteLength <= MAX_TASK_TOOL_RESULT_CHARACTERS) {
                return part;
              }
              const content =
                output.type === 'text' || output.type === 'error-text' ? output.value : serialized;
              return {
                ...part,
                output: {
                  type:
                    output.type === 'error-text' || output.type === 'error-json'
                      ? 'error-text'
                      : 'text',
                  value: `${content.slice(0, MAX_TASK_TOOL_RESULT_CHARACTERS)}\n${TRUNCATED_TOOL_RESULT}`,
                  ...('providerOptions' in output && output.providerOptions
                    ? { providerOptions: output.providerOptions }
                    : {}),
                },
              };
            }),
          } satisfies ModelMessage;
        }),
      };
    }

    if (checkpointSize(checkpoint) > MAX_TASK_CHECKPOINT_BYTES) {
      checkpoint = {
        subagentType: value.subagentType,
        sessionId: value.sessionId,
        mode: value.mode,
        messages: [{ role: 'user', content: CONTEXT_EXHAUSTED }],
        state: 'error',
        contextExhausted: true,
        stepCount: value.stepCount,
        finishReason: value.finishReason?.slice(0, MAX_TASK_TOOL_RESULT_CHARACTERS),
        lastText: value.lastText?.slice(0, MAX_TASK_TOOL_RESULT_CHARACTERS),
      };
    }

    await storage.put(key, checkpoint);
    return { contextExhausted, error: contextExhausted ? CONTEXT_EXHAUSTED : undefined };
  } catch (error) {
    return {
      contextExhausted,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createTaskTool(options: {
  parentSessionId: string;
  createModel: (session: TaskSession) => LanguageModel;
  reviewContext: string;
  prepared: boolean;
  workspace: ReviewWorkspace;
  github: ToolSet;
  storage: TaskStorage;
  onTaskState?: (outcome: TaskOutcome) => void | Promise<void>;
  generate?: typeof generateText;
}) {
  const ws = createWorkspaceTools(options.workspace, { bash: false });
  const childTools: ToolSet = {
    read: createReviewReadTool(options.workspace),
    grep: createReviewGrepTool(options.workspace),
    list: ws.list,
    find: ws.find,
    ...pickTools(options.github),
  };
  const runGenerate = options.generate ?? generateText;
  let activeTasks = 0;
  const activeTaskSessions = new Map<string, TaskSession>();

  return tool({
    description:
      'Run a bounded, read-only review child inheriting the resolved policy and snapshot. Resume failed tasks by task_id; partial results are not completion.',
    inputSchema: taskInputSchema,
    execute: async (input: TaskInput, { abortSignal }) => {
      if (!subagentTypeSchema.safeParse(input.subagent_type).success) {
        throw new Error(`Unsupported subagent_type: ${String(input.subagent_type)}`);
      }
      const id = input.task_id ?? crypto.randomUUID();
      const key = `task:${id}`;
      let session: TaskSession = {
        taskId: id,
        sessionId: crypto.randomUUID(),
        parentSessionId: options.parentSessionId,
        mode: input.subagent_type,
      };
      let subagentType = input.subagent_type;
      let resumed = false;
      const newMessage: ModelMessage = { role: 'user', content: input.prompt };
      let messages: ModelMessage[] = [{ role: 'user', content: options.reviewContext }, newMessage];
      let checkpointMessages = messages;
      let checkpointStepCount = 0;
      let checkpointFinishReason: string | undefined;
      let checkpointText = '';
      let contextExhausted = false;
      let checkpointFailure: string | undefined;
      let acquiredConcurrency = false;
      const metadata = (state: TerminalTaskState): TaskMetadata => ({
        ...session,
        subagentType,
        state,
        resumed,
        stepCount: checkpointStepCount,
        finishReason: checkpointFinishReason,
        contextExhausted,
      });
      const checkpoint = (state: TaskState): StoredTask => ({
        subagentType,
        sessionId: session.sessionId,
        mode: session.mode,
        messages: checkpointMessages,
        state,
        stepCount: checkpointStepCount,
        finishReason: checkpointFinishReason,
        lastText: checkpointText || undefined,
        contextExhausted,
      });
      const save = async (state: TaskState) => {
        const persisted = await persistTask(options.storage, key, checkpoint(state));
        contextExhausted ||= persisted.contextExhausted;
        if (persisted.error) {
          checkpointFailure = persisted.error;
          throw new Error(persisted.error);
        }
      };

      const activeSession = activeTaskSessions.get(id);
      if (activeSession) {
        return taskResult(
          input.description,
          `task is already running; resume with task_id="${id}" after it finishes`,
          { ...metadata('error'), ...activeSession }
        );
      }
      activeTaskSessions.set(id, session);

      try {
        const stored = storedTaskSchema.optional().parse(await options.storage.get<unknown>(key));
        resumed = stored !== undefined;
        if (stored) {
          subagentType = stored.subagentType;
          const sessionId = stored.sessionId ?? options.parentSessionId;
          session = {
            taskId: id,
            sessionId,
            mode: stored.mode ?? 'code',
            ...(sessionId !== options.parentSessionId
              ? { parentSessionId: options.parentSessionId }
              : {}),
          };
          contextExhausted =
            stored.contextExhausted === true ||
            JSON.stringify(stored.messages).includes(TRUNCATED_TOOL_RESULT);
          const inherited = stored.messages[0];
          messages = [
            ...(inherited?.role === 'user' && inherited.content === options.reviewContext
              ? []
              : [{ role: 'user' as const, content: options.reviewContext }]),
            ...stored.messages,
            newMessage,
          ];
          checkpointMessages = messages;
          activeTaskSessions.set(id, session);
          if (subagentType !== input.subagent_type)
            throw new Error('A resumed task must keep its original subagent type');
          if (contextExhausted) throw new Error(CONTEXT_EXHAUSTED);
        }
        if (activeTasks >= MAX_TASK_CONCURRENCY) {
          throw new Error(`task concurrency limit reached (${MAX_TASK_CONCURRENCY})`);
        }
        activeTasks += 1;
        acquiredConcurrency = true;
        await save('running');
        await options.onTaskState?.({ ...metadata('error'), state: 'running' });
        abortSignal?.throwIfAborted();

        const result = await runGenerate({
          model: options.createModel(session),
          abortSignal,
          system: buildChildSystemPrompt(subagentType, options.prepared),
          messages,
          tools: childTools,
          stopWhen: [stepCountIs(MAX_TASK_STEPS), () => checkpointFailure !== undefined],
          onStepEnd: async step => {
            checkpointMessages = [
              ...(step.request.messages ?? checkpointMessages),
              ...step.response.messages,
            ];
            checkpointStepCount = step.stepNumber + 1;
            checkpointFinishReason = step.finishReason;
            if (step.text.trim()) checkpointText = step.text;
            await save('running');
          },
        });
        abortSignal?.throwIfAborted();
        if (checkpointFailure) throw new Error(checkpointFailure);
        checkpointMessages = [...messages, ...result.responseMessages];
        checkpointStepCount = result.steps.length;
        checkpointFinishReason = result.finalStep.finishReason;
        const responseText = [result.text, lastAssistantText(result.responseMessages)].find(text =>
          text.trim()
        );
        checkpointText = responseText || checkpointText;
        if (checkpointFinishReason !== 'stop' || result.finalStep.toolCalls.length !== 0) {
          throw new Error(
            checkpointStepCount >= MAX_TASK_STEPS
              ? `Child exhausted its ${MAX_TASK_STEPS}-step budget; partial text is incomplete`
              : `Child did not finish cleanly (${checkpointFinishReason}); partial text is incomplete`
          );
        }
        if (!responseText) {
          throw new Error(
            `Child completed without a textual result; resume with task_id="${id}" to continue.`
          );
        }
        await save('completed');
        const outcome = metadata('completed');
        await options.onTaskState?.(outcome);
        return taskResult(input.description, responseText, outcome);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const persisted = await persistTask(options.storage, key, checkpoint('error'));
        contextExhausted ||= persisted.contextExhausted;
        const outcome = metadata('error');
        await options.onTaskState?.(outcome);
        return taskResult(
          input.description,
          persisted.error && persisted.error !== errorMessage
            ? `${errorMessage}; failed to persist task state: ${persisted.error}`
            : errorMessage,
          outcome
        );
      } finally {
        if (acquiredConcurrency) activeTasks -= 1;
        activeTaskSessions.delete(id);
      }
    },
  });
}
