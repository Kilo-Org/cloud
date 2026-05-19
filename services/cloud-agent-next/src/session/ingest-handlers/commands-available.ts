import { z } from 'zod';
import {
  toSlashCommandInfo,
  commandsOrDefault,
  type SlashCommandInfo,
} from '../../shared/slash-commands.js';

export type CommandsAvailableContext = {
  /** Persist the catalog in DO metadata. */
  setAvailableCommands: (commands: SlashCommandInfo[]) => Promise<void>;
  logger: {
    info: (msg: string, data?: object) => void;
    warn: (msg: string, data?: object) => void;
  };
};

const commandsPayloadSchema = z.object({
  commands: z.array(z.unknown()),
});

/**
 * Validate the wrapper-supplied catalog and persist it to DO metadata.
 * Items that fail validation are dropped silently — we'd rather hand the
 * client a partially trimmed list than reject the whole event.
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
  await ctx.setAvailableCommands(toPersist);
  ctx.logger.info('Cached slash command catalog', { count: toPersist.length });
}
