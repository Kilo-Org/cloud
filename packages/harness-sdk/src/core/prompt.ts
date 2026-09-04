import { Context } from 'effect';
import type { Turn, TurnRole } from './turn.js';

/**
 * A block of the system prompt. `cache` marks a cache breakpoint: the model
 * caches every byte up to and including this block.
 */
interface PromptBlock {
  readonly text: string;
  readonly cache: boolean;
}

/**
 * One piece of a message, as the transport plugin will render it.
 *
 * Reasoning is here, and it goes back to the provider unchanged. Stripping it
 * saves nothing — the API drops what the model cannot read, unbilled — and
 * removing a block can fail the request on ordering or on the signature. A
 * reasoning part with no signature cannot be replayed at all, so the shape
 * leaves that one out.
 */
type PromptPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string; readonly signature?: string }
  | { readonly kind: 'redacted'; readonly data: string }
  | { readonly kind: 'image'; readonly media: string; readonly data: string };

/** `cache` marks the breakpoint, which belongs to the message, not to a part. */
interface PromptMessage {
  readonly role: TurnRole;
  readonly parts: readonly PromptPart[];
  readonly cache: boolean;
}

/** What the transport plugin sends. The order on the wire is system, then messages. */
interface Prompt {
  readonly system: readonly PromptBlock[];
  readonly messages: readonly PromptMessage[];
}

interface PromptInput {
  readonly system: string;
  readonly turns: readonly Turn[];
}

/**
 * Turns a session into a prompt. This is where the model cache is won or lost,
 * so an assembler must hold two invariants:
 *
 * 1. The same input gives the same bytes. No clock, no random value, no key
 *    order that varies.
 * 2. Appending a turn changes nothing before that turn.
 */
interface PromptAssemblerService {
  readonly assemble: (input: PromptInput) => Prompt;
}

/** The text of a message, which is all of it for a message that carries no image. */
const textIn = (message: PromptMessage): string =>
  message.parts
    .filter(part => part.kind === 'text')
    .map(part => part.text)
    .join('');

class PromptAssembler extends Context.Tag('harness/PromptAssembler')<
  PromptAssembler,
  PromptAssemblerService
>() {}

export type { Prompt, PromptAssemblerService, PromptBlock, PromptInput, PromptMessage, PromptPart };
export { PromptAssembler, textIn };
