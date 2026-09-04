import type { Prompt, PromptPart } from '../../../core/prompt.js';
import type { Wire } from './wire.js';

/**
 * What the wire tests share: a prompt of one assistant message, and the body a
 * shape makes of it. It lives outside a `*.test.ts` file so more than one test
 * file can use it, and it is excluded from `dist/` with the other test doubles.
 */

/** What one shape puts on the wire for a prompt, so a test can read the blocks. */
const bodyOf = (wire: Wire, prompt: Prompt): unknown =>
  wire.toBody({ prompt, model: 'm', maxTokens: 8, stream: false });

/** One assistant message of the given parts, with a system prompt in front. */
const promptOf = (parts: readonly PromptPart[]): Prompt => ({
  system: [{ text: 'sys', cache: true }],
  messages: [{ role: 'assistant', parts, cache: false }],
});

export { bodyOf, promptOf };
