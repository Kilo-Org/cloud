import { Chunk, Layer } from 'effect';
import { PromptAssembler, type Prompt, type PromptInput } from '../../core/prompt.js';

/**
 * The core assembler. It sets two breakpoints: one after the system prompt,
 * which every request of every session reads, and one on the last turn, which
 * the next request of this session reads.
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

const layerAssembler: Layer.Layer<PromptAssembler> = Layer.succeed(PromptAssembler, { assemble });

export { assemble, layerAssembler };
