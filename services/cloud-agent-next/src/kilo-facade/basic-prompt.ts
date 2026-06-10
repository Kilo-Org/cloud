import * as z from 'zod';
import { Limits } from '../schema.js';
import { MessageIdSchema, ModeSlugSchema, modelIdSchema } from '../router/schemas.js';

const basicTextPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .strict();

const basicPromptBodySchema = z
  .object({
    messageID: MessageIdSchema.optional(),
    agent: ModeSlugSchema.optional(),
    model: z
      .object({
        providerID: z.literal('kilo'),
        modelID: modelIdSchema,
      })
      .strict()
      .optional(),
    parts: z.array(basicTextPartSchema).min(1),
  })
  .strict();

export type BasicKiloPrompt = {
  messageId?: string;
  prompt: string;
  agent?: {
    mode?: string;
    model?: string;
  };
};

export type BasicKiloPromptParseResult =
  | { success: true; prompt: BasicKiloPrompt }
  | { success: false };

export function parseBasicKiloPrompt(value: unknown): BasicKiloPromptParseResult {
  const result = basicPromptBodySchema.safeParse(value);
  if (!result.success) {
    return { success: false };
  }

  const prompt = result.data.parts.map(part => part.text).join('');
  if (prompt.length === 0 || prompt.length > Limits.MAX_PROMPT_LENGTH) {
    return { success: false };
  }

  const mode = result.data.agent;
  const model = result.data.model?.modelID;
  return {
    success: true,
    prompt: {
      messageId: result.data.messageID,
      prompt,
      ...(mode !== undefined || model !== undefined
        ? {
            agent: {
              ...(mode !== undefined ? { mode } : {}),
              ...(model !== undefined ? { model } : {}),
            },
          }
        : {}),
    },
  };
}
