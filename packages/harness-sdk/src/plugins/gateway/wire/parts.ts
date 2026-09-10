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

/**
 * How a failed result reads to a model on a shape that has no flag for one.
 *
 * The Anthropic shape marks a failed result on the block itself. Neither OpenAI
 * shape has anywhere to put it, and a failure the model cannot tell from an
 * answer is a failure it will build on, so it is said in the text instead.
 */
const failedText = (body: string): string => `The tool call failed. ${body}`;

/** What a result reads as on a shape with no flag: the text says which it is. */
const resultText = (body: string, failed: boolean): string => (failed ? failedText(body) : body);

export { dataUri, isLast, resultText };
