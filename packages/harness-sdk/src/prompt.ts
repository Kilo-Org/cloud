import { Chunk, Context, Layer } from 'effect';
import type { Turn, TurnRole } from './turn.js';

/**
 * A block of the prompt. `cache` marks a cache breakpoint: the model caches
 * every byte up to and including this block.
 */
interface PromptBlock {
  readonly text: string;
  readonly cache: boolean;
}

interface PromptMessage extends PromptBlock {
  readonly role: TurnRole;
}

/** What the transport plugin sends. The order on the wire is system, then messages. */
interface Prompt {
  readonly system: readonly PromptBlock[];
  readonly messages: readonly PromptMessage[];
}

interface PromptInput {
  readonly system: string;
  readonly turns: Chunk.Chunk<Turn>;
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

class PromptAssembler extends Context.Tag('harness/PromptAssembler')<
  PromptAssembler,
  PromptAssemblerService
>() {}

/**
 * The core plugin. It sets two breakpoints: one after the system prompt, which
 * every request of every session reads, and one on the last turn, which the
 * next request of this session reads.
 */
const assemble = ({ system, turns }: PromptInput): Prompt => {
  const count = Chunk.size(turns);
  return {
    system: [{ text: system, cache: true }],
    messages: Chunk.toReadonlyArray(turns).map((turn, index) => ({
      role: turn.role,
      text: turn.content,
      cache: index === count - 1,
    })),
  };
};

const layerDefault: Layer.Layer<PromptAssembler> = Layer.succeed(PromptAssembler, { assemble });

export type { Prompt, PromptAssemblerService, PromptBlock, PromptInput, PromptMessage };
export { assemble, layerDefault, PromptAssembler };
