import type { CommandsAvailableData } from '../../shared/protocol.js';
import { toSlashCommandInfo, type SlashCommandInfo } from '../../shared/slash-commands.js';

export type CommandsAvailableContext = {
  /** Persist the catalog in DO metadata. */
  setAvailableCommands: (commands: SlashCommandInfo[]) => Promise<void>;
  logger: {
    info: (msg: string, data?: object) => void;
    warn: (msg: string, data?: object) => void;
  };
};

/**
 * Validate the wrapper-supplied catalog and persist it to DO metadata.
 * Items that fail validation are dropped silently — we'd rather hand the
 * client a partially trimmed list than reject the whole event.
 */
export async function handleCommandsAvailable(
  data: unknown,
  ctx: CommandsAvailableContext
): Promise<void> {
  const raw = (data as Partial<CommandsAvailableData> | undefined)?.commands;
  if (!Array.isArray(raw)) {
    ctx.logger.warn('commands.available payload missing commands array');
    return;
  }

  const validated: SlashCommandInfo[] = [];
  for (const item of raw) {
    const trimmed = toSlashCommandInfo(item);
    if (trimmed) validated.push(trimmed);
  }

  await ctx.setAvailableCommands(validated);
  ctx.logger.info('Cached slash command catalog', { count: validated.length });
}
