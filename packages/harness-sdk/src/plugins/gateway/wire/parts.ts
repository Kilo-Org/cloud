import type { PromptMessage, PromptPart } from '../../../core/prompt.js';

/**
 * What every shape needs from a message's parts.
 *
 * The cache breakpoint belongs to the message, not to a part, and a provider
 * reads it on a block. So it goes on the last block of the message: everything
 * before it is then inside the cached prefix.
 */
const isLast = (message: PromptMessage, index: number): boolean =>
  message.cache && index === message.parts.length - 1;

/**
 * An image as a data URI, which is how both OpenAI shapes take one.
 *
 * The bytes are already base64, because that is how a part is stored. Nothing
 * is decoded and encoded again on the way out.
 */
const dataUri = (part: Extract<PromptPart, { kind: 'image' }>): string =>
  `data:${part.media};base64,${part.data}`;

export { dataUri, isLast };
