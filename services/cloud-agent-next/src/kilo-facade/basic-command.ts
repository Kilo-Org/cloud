import type { SessionCommandResponse } from '@kilocode/sdk/v2';
import * as z from 'zod';
import { MessageIdSchema, ModeSlugSchema, modelIdSchema } from '../router/schemas.js';
import { Limits } from '../schema.js';

const commandBodySchema = z
  .object({
    messageID: MessageIdSchema.optional(),
    command: z
      .string()
      .min(1)
      .max(Limits.MAX_RUNTIME_KILO_COMMAND_NAME_LENGTH)
      .refine(command => command.trim().length > 0),
    arguments: z.string().max(Limits.MAX_PROMPT_LENGTH),
    agent: ModeSlugSchema.optional(),
    model: z.string().optional(),
    variant: z.string().min(1).max(255).optional(),
    snapshotInitialization: z.literal('wait').optional(),
    parts: z.array(z.never()).optional(),
  })
  .strict();

export type BasicKiloCommand = {
  messageId?: string;
  command: string;
  arguments: string;
  agent?: {
    mode?: string;
    model?: string;
    variant?: string;
  };
  snapshotInitialization?: 'wait';
};

export type BasicKiloCommandParseResult =
  | { success: true; command: BasicKiloCommand }
  | { success: false; reason: 'invalid' | 'parts-unsupported' };

function parseKiloModel(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  const separator = value.indexOf('/');
  if (separator < 0 || value.slice(0, separator) !== 'kilo') return null;
  const model = value.slice(separator + 1);
  return modelIdSchema.safeParse(model).success ? model : null;
}

export function parseBasicKiloCommand(value: unknown): BasicKiloCommandParseResult {
  if (
    typeof value === 'object' &&
    value !== null &&
    'parts' in value &&
    Array.isArray(value.parts) &&
    value.parts.length > 0
  ) {
    return { success: false, reason: 'parts-unsupported' };
  }

  const result = commandBodySchema.safeParse(value);
  if (!result.success) return { success: false, reason: 'invalid' };
  const model = parseKiloModel(result.data.model);
  if (model === null) return { success: false, reason: 'invalid' };

  const mode = result.data.agent;
  const variant = result.data.variant;
  return {
    success: true,
    command: {
      messageId: result.data.messageID,
      command: result.data.command,
      arguments: result.data.arguments,
      ...(mode !== undefined || model !== undefined || variant !== undefined
        ? {
            agent: {
              ...(mode !== undefined ? { mode } : {}),
              ...(model !== undefined ? { model } : {}),
              ...(variant !== undefined ? { variant } : {}),
            },
          }
        : {}),
      ...(result.data.snapshotInitialization !== undefined
        ? { snapshotInitialization: result.data.snapshotInitialization }
        : {}),
    },
  };
}

export function buildSyntheticCommandResponse(params: {
  now: number;
  assistantMessageId: string;
  admittedMessageId: string;
  kiloSessionId: string;
  publicDirectory: string;
  requestedAgent?: string;
  requestedModel?: string;
  variant?: string;
}): SessionCommandResponse {
  const agent = params.requestedAgent ?? 'unknown';
  return {
    info: {
      id: params.assistantMessageId,
      sessionID: params.kiloSessionId,
      role: 'assistant',
      time: { created: params.now },
      parentID: params.admittedMessageId,
      modelID: params.requestedModel ?? 'unknown',
      providerID: 'kilo',
      mode: agent,
      agent,
      path: { cwd: params.publicDirectory, root: params.publicDirectory },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      ...(params.variant !== undefined ? { variant: params.variant } : {}),
    },
    // Temporary VS Code compatibility acknowledgement; real command output arrives through
    // events/messages until Kilo exposes an async command API or Cloud Agent has a durable waiter.
    parts: [],
  };
}
