import { z } from 'zod';
import type { ModelReply, ModelRequest } from './model.js';
import type { TurnRole } from './turn.js';

/** The Anthropic Messages body. `cache_control` marks a cache breakpoint. */
interface ContentBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: { readonly type: 'ephemeral' };
}

interface MessagesBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: readonly ContentBlock[];
  readonly messages: readonly {
    readonly role: TurnRole;
    readonly content: readonly ContentBlock[];
  }[];
}

const ephemeral = { type: 'ephemeral' } as const;

const block = (text: string, cache: boolean): ContentBlock =>
  cache ? { type: 'text', text, cache_control: ephemeral } : { type: 'text', text };

/** Maps a request onto the Anthropic Messages body the gateway forwards upstream. */
const toBody = ({ prompt, model, maxTokens }: ModelRequest): MessagesBody => ({
  model,
  max_tokens: maxTokens,
  system: prompt.system.map(part => block(part.text, part.cache)),
  messages: prompt.messages.map(message => ({
    role: message.role,
    content: [block(message.text, message.cache)],
  })),
});

/** The reply is an edge, so it is validated before the package believes it. */
const ReplySchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().nullish(),
    cache_creation_input_tokens: z.number().nullish(),
  }),
});

const toReply = (raw: z.infer<typeof ReplySchema>): ModelReply => ({
  content: raw.content.map(part => part.text ?? '').join(''),
  usage: {
    inputTokens: raw.usage.input_tokens,
    outputTokens: raw.usage.output_tokens,
    cacheReadTokens: raw.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: raw.usage.cache_creation_input_tokens ?? 0,
  },
});

export type { ContentBlock, MessagesBody };
export { ReplySchema, toBody, toReply };
