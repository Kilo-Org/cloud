import * as z from 'zod';
import { Limits } from '../schema.js';
import { MessageIdSchema } from '../router/schemas.js';

const basicTextPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .strict();

const basicPromptBodySchema = z
  .object({
    messageID: MessageIdSchema.optional(),
    parts: z.array(basicTextPartSchema).min(1),
  })
  .strict();

export type BasicKiloPrompt = {
  messageId?: string;
  prompt: string;
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

  return {
    success: true,
    prompt: {
      messageId: result.data.messageID,
      prompt,
    },
  };
}
