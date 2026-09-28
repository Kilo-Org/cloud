import { z } from 'zod';
import type { CommandsAvailableData } from '../../shared/protocol.js';
import {
  toSlashCommandInfo,
  commandsOrDefault,
  type SlashCommandInfo,
} from '../../shared/slash-commands.js';

export type CommandsAvailableContext = {
  /**
   * Persist the catalog and its bound status in DO storage. The payload is the
   * same shape a connecting client is hydrated with (`CommandsAvailableData`).
   */
  setAvailableCommands: (data: CommandsAvailableData) => Promise<void>;
  logger: {
    info: (msg: string, data?: object) => void;
    warn: (msg: string, data?: object) => void;
  };
};

const catalogStatusSchema = z.object({
  dropped: z.number().int().nonnegative(),
  overLimit: z.boolean(),
});

const commandsPayloadSchema = z.object({
  commands: z.array(z.unknown()),
  // The notice is a nicety and the catalog is essential, so a malformed status
  // is dropped instead of rejecting the event and losing the catalog.
  catalogStatus: catalogStatusSchema.optional().catch(undefined),
});

/**
 * Validate the wrapper-supplied catalog and persist it to DO storage.
 * Items that fail validation are dropped silently — we'd rather hand the
 * client a partially trimmed list than reject the whole event.
 *
 * A `catalogStatus` that fails validation is dropped too: the catalog still
 * reaches the client, and only the notice about the bound is lost.
 */
export async function handleCommandsAvailable(
  data: unknown,
  ctx: CommandsAvailableContext
): Promise<void> {
  const parsed = commandsPayloadSchema.safeParse(data);
  if (!parsed.success) {
    ctx.logger.warn('commands.available payload missing commands array');
    return;
  }

  const validated: SlashCommandInfo[] = [];
  for (const item of parsed.data.commands) {
    const trimmed = toSlashCommandInfo(item);
    if (trimmed) validated.push(trimmed);
  }

  const toPersist = commandsOrDefault(validated);
  await ctx.setAvailableCommands({
    commands: toPersist,
    ...(parsed.data.catalogStatus ? { catalogStatus: parsed.data.catalogStatus } : {}),
  });
  ctx.logger.info('Cached slash command catalog', {
    count: toPersist.length,
    ...(parsed.data.catalogStatus ? { catalogStatus: parsed.data.catalogStatus } : {}),
  });
}
