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
 * Reasoning goes back out with the rest. The provider drops what the model
 * cannot read and does not bill for it, and a block removed by hand can fail
 * the request on ordering or on its signature, so the package hands back what
 * it was given and lets the provider decide.
 */
const renderPart = (part: TurnPart): readonly PromptPart[] => {
  switch (part.kind) {
    /* A summary is text to the model. It is a kind of its own only so the
       session can find where the prompt starts. */
    case 'summary':
    case 'text': {
      return [{ kind: 'text', text: part.body }];
    }
    case 'image': {
      return [{ kind: 'image', media: part.media, data: part.body }];
    }
    case 'redacted': {
      return [{ kind: 'redacted', data: part.body }];
    }
    case 'reasoning': {
      return [
        {
          kind: 'reasoning',
          text: part.body,
          ...(part.signature === undefined ? {} : { signature: part.signature }),
        },
      ];
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
