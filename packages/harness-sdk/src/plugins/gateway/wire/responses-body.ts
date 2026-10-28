import type OpenAI from 'openai';
import { createAssert } from 'typia';
import type { ModelRequest } from '../../../core/model.js';
import type { PromptMessage, PromptPart } from '../../../core/prompt.js';
import type { ToolDefinition } from '../../../core/tool.js';
import { dataUri, resultText } from './parts.js';

/**
 * The OpenAI Responses shape. It has no cache breakpoint. It caches on
 * `prompt_cache_key`, so the caller passes the session identifier and every
 * request of one session lands on the same cache entry.
 */
type ResponsesBody = OpenAI.Responses.ResponseCreateParams;

/**
 * This shape has no cache breakpoint, so a part carries no mark. An image goes
 * as a data URI, which is the only way this shape takes bytes.
 *
 * Thinking is not message content here. It is an item beside the message, so it
 * is rendered by `itemsOf` rather than by this.
 */
const renderPart = (part: PromptPart): OpenAI.Responses.ResponseInputContent | undefined => {
  switch (part.kind) {
    case 'text': {
      return { type: 'input_text', text: part.text };
    }
    case 'image': {
      return { type: 'input_image', image_url: dataUri(part), detail: 'auto' };
    }
    /* A block the provider encrypted belongs to the Anthropic shape: this one
       encrypts the whole reasoning item instead, and the two are not the same
       bytes. A call and its result are items beside the message, not content in
       it. All four are rendered by `itemsOf`, or by nothing at all. */
    case 'redacted':
    case 'reasoning':
    case 'toolCall':
    case 'toolResult': {
      return undefined;
    }
  }
};

/**
 * A call, or its result, as the item this shape takes. The arguments go across
 * as the text the model wrote, which is what this shape asks for, so a call
 * that could not be run replays exactly as it was made. There is no flag for a
 * failed result here, so the text says so instead.
 */
const toolItem = (part: PromptPart): OpenAI.Responses.ResponseInputItem | undefined => {
  if (part.kind === 'toolCall') {
    return {
      type: 'function_call',
      call_id: part.callId,
      name: part.name,
      arguments: part.arguments,
    };
  }
  return part.kind === 'toolResult'
    ? {
        type: 'function_call_output',
        call_id: part.callId,
        output: resultText(part.body, part.failed),
      }
    : undefined;
};

/**
 * What this shape hides inside a signature: the item's identifier and the
 * provider's encrypted copy of the reasoning.
 *
 * A signature is opaque to the package and means only what the shape that made
 * it says it means. This one is not a signature at all; it is the two fields
 * this shape needs to hand a reasoning item back.
 */
interface ReasoningSeal {
  readonly id: string;
  readonly encrypted_content: string;
}

const assertSeal = createAssert<ReasoningSeal>();

/**
 * The reasoning item to send back, or nothing when there is none to send.
 *
 * A malformed seal throws, which the caller turns into a failed call. It cannot
 * be repaired and sending the item without it would be refused anyway.
 */
const reasoningItem = (part: PromptPart): OpenAI.Responses.ResponseReasoningItem | undefined => {
  if (part.kind !== 'reasoning' || part.signature === undefined) {
    return undefined;
  }
  const seal = assertSeal(JSON.parse(part.signature));
  return {
    type: 'reasoning',
    id: seal.id,
    encrypted_content: seal.encrypted_content,
    /* Empty because that is how the item arrived. The encrypted copy is the
       authoritative one, and a summary this package wrote instead of the
       provider is a change to a block the provider signed. */
    summary: [],
  };
};

/**
 * One message, as the items this shape takes.
 *
 * The reasoning goes first, as its own item, which is the order the model
 * produced it in and the order this shape reports it in. A message with nothing
 * but reasoning produces no message item at all: an empty one is refused.
 */
const itemsOf = (message: PromptMessage): OpenAI.Responses.ResponseInputItem[] => {
  const thinking = message.parts.map(reasoningItem).filter(item => item !== undefined);
  const content = message.parts.map(renderPart).filter(part => part !== undefined);
  const tools = message.parts.map(toolItem).filter(item => item !== undefined);
  const said = content.length === 0 ? [] : [{ role: message.role, content }];
  return [...thinking, ...said, ...tools];
};

/**
 * A tool, as this shape takes one. `strict` is false because the schema comes
 * from the caller unchanged: strict mode adds rules a hand-written schema will
 * not always meet, and a rejected schema is a session that cannot start.
 */
const toolItemFor = (tool: ToolDefinition): OpenAI.Responses.FunctionTool => ({
  type: 'function',
  name: tool.name,
  description: tool.description,
  parameters: { ...tool.parameters },
  strict: false,
});

/* Typed `unknown` outward, as `completions-body.ts` is: the declaration must not
   name the OpenAI package, which a consumer does not install. */
const toBody = ({ prompt, model, maxTokens, cacheKey, effort, tools }: ModelRequest): unknown =>
  ({
    model,
    max_output_tokens: maxTokens,
    stream: true,
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    /* Without this the provider keeps the reasoning and hands back only an
       identifier, which is no use to a package that stores the session itself. */
    include: ['reasoning.encrypted_content'],
    store: false,
    instructions: prompt.system.map(part => part.text).join('\n'),
    ...(cacheKey === undefined ? {} : { prompt_cache_key: cacheKey }),
    ...(tools === undefined || tools.length === 0 ? {} : { tools: tools.map(toolItemFor) }),
    input: prompt.messages.flatMap(itemsOf),
  }) satisfies ResponsesBody;

export type { ReasoningSeal };
export { toBody };
