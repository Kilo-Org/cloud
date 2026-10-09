import { type ModelRequest, type StopReason } from '@kilocode/harness-sdk';
import { type CompletionParams, type LlamaContext } from 'llama.rn';
import { z } from 'zod';

import { type GgufModelFile } from './gguf-records';

/** The part of a llama.rn context that describes its model. */
type ModelInfo = Pick<LlamaContext, 'model'>['model'];

/**
 * The window a model runs with: its trained length, capped so the KV cache of a
 * small phone model stays small, and a multiple of the 256-token block that
 * llama.cpp pads the context to. A model that states no length gets the cap.
 */
const CONTEXT_CAP = 4096;
const CONTEXT_BLOCK = 256;

const ggufMetadata = z
  .object({ 'general.architecture': z.string().optional() })
  .catchall(z.unknown());

/** Reads the window out of a model's own GGUF metadata, which is untrusted file input. */
export function contextWindowFor(metadata: unknown): number {
  const fields = ggufMetadata.safeParse(metadata);
  if (!fields.success) {
    return CONTEXT_CAP;
  }
  const architecture = fields.data['general.architecture'];
  const trained = Number(
    architecture === undefined ? undefined : fields.data[`${architecture}.context_length`]
  );
  const window =
    Number.isFinite(trained) && trained > 0 ? Math.min(trained, CONTEXT_CAP) : CONTEXT_CAP;
  return Math.max(CONTEXT_BLOCK, Math.floor(window / CONTEXT_BLOCK) * CONTEXT_BLOCK);
}

/**
 * The tool rule. A model receives tool definitions only when the chat template
 * llama.rn renders with tools (the tool-use template when the model ships one,
 * otherwise its default) is a Jinja template that both renders the tool list
 * and renders the assistant's earlier tool calls. Anything else, including
 * llama.cpp's generic JSON fallback, is text-only.
 */
export function templateSupportsTools(templates: ModelInfo['chatTemplates']): boolean {
  const { jinja } = templates;
  let caps: typeof jinja.defaultCaps | undefined = undefined;
  if (jinja.toolUse) {
    caps = jinja.toolUseCaps;
  } else if (jinja.default) {
    caps = jinja.defaultCaps;
  }
  return caps?.tools === true && caps.toolCalls;
}

type LlamaMessage = {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly type: 'function';
    readonly id: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
};

/**
 * The OpenAI-shaped history llama.rn renders through the model's own template.
 * Reasoning and images never reach the model, and a turn that held nothing but
 * them is left out. Tool calls and results are kept only for a model that
 * verified tool support; otherwise they are dropped like every other part a
 * text-only model cannot read.
 */
function messagesOf(request: ModelRequest, tools: boolean): LlamaMessage[] {
  const messages: LlamaMessage[] = [];
  const system = request.prompt.system.map(block => block.text).join('\n\n');
  if (system !== '') {
    messages.push({ role: 'system', content: system });
  }
  for (const message of request.prompt.messages) {
    const text = message.parts
      .flatMap(part => (part.kind === 'text' ? [part.text] : []))
      .join('\n\n');
    if (message.role === 'assistant') {
      const calls = tools
        ? message.parts.flatMap(part =>
            part.kind === 'toolCall'
              ? [
                  {
                    type: 'function' as const,
                    id: part.callId,
                    function: { name: part.name, arguments: part.arguments },
                  },
                ]
              : []
          )
        : [];
      if (text !== '' || calls.length > 0) {
        messages.push({
          role: 'assistant',
          content: text,
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        });
      }
    }
    if (tools) {
      for (const part of message.parts) {
        if (part.kind === 'toolResult') {
          messages.push({ role: 'tool', tool_call_id: part.callId, content: part.body });
        }
      }
    }
    if (message.role === 'user' && text !== '') {
      messages.push({ role: 'user', content: text });
    }
  }
  return messages;
}

/** One llama.rn call: the model's own template renders it, so nothing is pre-formatted here. */
export function paramsOf(request: ModelRequest, file: GgufModelFile): CompletionParams {
  const tools = file.tools && request.tools !== undefined && request.tools.length > 0;
  return {
    messages: messagesOf(request, file.tools),
    jinja: true,
    // Small phone models answer directly; a thinking template would spend the window.
    enable_thinking: false,
    n_predict: Math.min(request.maxTokens, file.contextWindow),
    ...(tools
      ? {
          tool_choice: 'auto',
          tools: request.tools.map(tool => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }
      : {}),
  };
}

/**
 * What llama.rn resolves with. Its declared type does not match the native
 * object: the parsed `content` and `tool_calls` are absent when empty, and the
 * `stopped_*` fields arrive as booleans. `accumulated_text` is present only
 * when the template's output parser ran, which is when `content` is the answer.
 */
const completionResult = z
  .object({
    text: z.string().default(''),
    content: z.string().optional(),
    accumulated_text: z.string().optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string().optional(),
          function: z.object({ name: z.string(), arguments: z.string() }),
        })
      )
      .default([]),
    tokens_evaluated: z.number().default(0),
    tokens_predicted: z.number().default(0),
    // llama.cpp reports these as booleans, and older builds omit them entirely.
    interrupted: z.boolean().optional(),
    context_full: z.boolean().optional(),
    stopped_eos: z.boolean().optional(),
    stopped_word: z.boolean().optional(),
    stopped_limit: z.boolean().optional(),
  })
  .transform(flags => ({
    ...flags,
    interrupted: flags.interrupted ?? false,
    context_full: flags.context_full ?? false,
    stopped_eos: flags.stopped_eos ?? false,
    stopped_word: flags.stopped_word ?? false,
    stopped_limit: flags.stopped_limit ?? false,
  }));

export type CompletionResult = z.infer<typeof completionResult>;

export type CompletionOutcome =
  | { readonly ok: true; readonly value: CompletionResult }
  | { readonly ok: false };

/** Reads the native result, turning any shape this build cannot read into a failure. */
export function readCompletion(result: unknown): CompletionOutcome {
  const parsed = completionResult.safeParse(result);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/** The answer text, which is the parsed content once the template's parser has run. */
export function answerOf(result: CompletionResult): string {
  return result.accumulated_text === undefined ? result.text : (result.content ?? '');
}

export function stopOf(result: CompletionResult): StopReason {
  if (result.tool_calls.length > 0) {
    return 'tools';
  }
  if (result.stopped_limit || result.context_full) {
    return 'maxTokens';
  }
  return result.stopped_eos || result.stopped_word ? 'end' : 'unknown';
}
