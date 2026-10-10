import { type ModelRequest, type PromptPart, type StopReason } from '@kilocode/harness-sdk';
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

/** A user turn with an image is a list of parts, in the order the person wrote them. */
type LlamaContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

type LlamaMessage = {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | LlamaContentPart[];
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly type: 'function';
    readonly id: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
};

/**
 * A user turn with an image, for a model whose projector is loaded. The image
 * goes as a data URL: llama.rn puts its media marker where the image was and
 * decodes the base64 itself, so no image file is written.
 */
function imageContent(parts: readonly PromptPart[]): LlamaContentPart[] {
  return parts.flatMap((part): LlamaContentPart[] => {
    if (part.kind === 'text') {
      return [{ type: 'text', text: part.text }];
    }
    if (part.kind === 'image') {
      return [{ type: 'image_url', image_url: { url: `data:${part.media};base64,${part.data}` } }];
    }
    return [];
  });
}

/**
 * The OpenAI-shaped history llama.rn renders through the model's own template.
 * Reasoning never reaches the model, images reach only a model whose projector
 * is loaded, and a turn that held nothing the model reads is left out. Tool
 * calls and results are kept only for a model that verified tool support;
 * otherwise they are dropped like every other part a text-only model cannot read.
 */
function messagesOf(request: ModelRequest, file: GgufModelFile): LlamaMessage[] {
  const { tools } = file;
  const vision = file.projector !== undefined;
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
    if (message.role === 'user' && vision && message.parts.some(part => part.kind === 'image')) {
      messages.push({ role: 'user', content: imageContent(message.parts) });
    } else if (message.role === 'user' && text !== '') {
      messages.push({ role: 'user', content: text });
    }
  }
  return messages;
}

/** One llama.rn call: the model's own template renders it, so nothing is pre-formatted here. */
export function paramsOf(request: ModelRequest, file: GgufModelFile): CompletionParams {
  const tools = file.tools && request.tools !== undefined && request.tools.length > 0;
  return {
    messages: messagesOf(request, file),
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
    text: z
      .string()
      .nullish()
      .transform(value => value ?? ''),
    // The native object carries null rather than omitting a field, and the
    // parsed content is absent unless the template's output parser ran.
    content: z.string().nullish(),
    accumulated_text: z.string().nullish(),
    tool_calls: z
      .array(
        z.object({
          id: z.string().nullish(),
          function: z.object({
            name: z.string(),
            // A model that stops mid-call leaves the arguments absent.
            arguments: z.string().nullish(),
          }),
        })
      )
      .nullish()
      .transform(calls => calls ?? []),
    tokens_evaluated: z
      .number()
      .nullish()
      .transform(value => value ?? 0),
    tokens_predicted: z
      .number()
      .nullish()
      .transform(value => value ?? 0),
    // llama.cpp reports these as booleans, and older builds omit them entirely.
    interrupted: z.boolean().nullish(),
    context_full: z.boolean().nullish(),
    stopped_eos: z.boolean().nullish(),
    stopped_word: z.boolean().nullish(),
    stopped_limit: z.boolean().nullish(),
  })
  .transform(flags => ({
    ...flags,
    // `answerOf` reads a present `accumulated_text` as "the parser ran", so a
    // native null has to become absent rather than stay a value.
    content: flags.content ?? undefined,
    accumulated_text: flags.accumulated_text ?? undefined,
    tool_calls: flags.tool_calls.map(call => ({
      id: call.id ?? undefined,
      function: { name: call.function.name, arguments: call.function.arguments ?? '' },
    })),
    interrupted: flags.interrupted ?? false,
    context_full: flags.context_full ?? false,
    stopped_eos: flags.stopped_eos ?? false,
    stopped_word: flags.stopped_word ?? false,
    stopped_limit: flags.stopped_limit ?? false,
  }))
  // A result with no words and no calls is not an answer, whatever else it holds.
  .refine(
    value =>
      value.text.length > 0 || value.accumulated_text !== undefined || value.tool_calls.length > 0
  );

/**
 * The least this build needs to answer: the text the model produced.
 *
 * A result that fails the full read still holds an answer, and failing the turn
 * would throw away words the person waited for. Its counts and stop reason are
 * reported as nothing reported them.
 */
const degradedCompletion = z
  .object({
    text: z.string().nullish(),
    content: z.string().nullish(),
    accumulated_text: z.string().nullish(),
  })
  .transform(flags => {
    const answer = flags.accumulated_text ?? flags.content ?? flags.text ?? '';
    return {
      text: flags.text ?? answer,
      content: flags.accumulated_text === undefined ? (flags.content ?? undefined) : answer,
      accumulated_text: flags.accumulated_text ?? undefined,
      tool_calls: [],
      tokens_evaluated: 0,
      tokens_predicted: 0,
      interrupted: false,
      context_full: false,
      stopped_eos: false,
      stopped_word: false,
      stopped_limit: false,
    };
  })
  .refine(parsed => parsed.text.length > 0 || parsed.accumulated_text !== undefined);

export type CompletionResult = z.infer<typeof completionResult>;

export type CompletionOutcome =
  | { readonly ok: true; readonly value: CompletionResult }
  | { readonly ok: false };

/**
 * Reads the native result. A shape the full read refuses still answers when it
 * carries text, because the alternative is failing a turn the model finished.
 */
export function readCompletion(result: unknown): CompletionOutcome {
  const parsed = completionResult.safeParse(result);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const degraded = degradedCompletion.safeParse(result);
  return degraded.success ? { ok: true, value: degraded.data } : { ok: false };
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
