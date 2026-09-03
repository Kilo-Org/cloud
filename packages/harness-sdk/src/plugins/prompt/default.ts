import { Chunk, Layer } from 'effect';
import {
  PromptAssembler,
  type Prompt,
  type PromptInput,
  type PromptPart,
} from '../../core/prompt.js';
import type { TurnPart } from '../../core/turn.js';

/**
 * Maps one turn part onto what the transport sends.
 *
 * Reasoning is dropped. A provider issues a signature with a thinking block and
 * rejects the block when it comes back without one, so the package keeps the
 * reasoning for whoever reads the session and never puts it in a prompt.
 */
const renderPart = (part: TurnPart): readonly PromptPart[] => {
  switch (part.kind) {
    case 'text': {
      return [{ kind: 'text', text: part.body }];
    }
    case 'image': {
      return [{ kind: 'image', media: part.media, data: part.body }];
    }
    case 'reasoning': {
      return [];
    }
  }
};

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
      parts: turn.parts.flatMap(renderPart),
      cache: index === count - 1,
    })),
  };
};

const layerAssembler: Layer.Layer<PromptAssembler> = Layer.succeed(PromptAssembler, { assemble });

export { assemble, layerAssembler };
