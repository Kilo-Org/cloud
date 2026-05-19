import { describe, expect, it, vi } from 'vitest';
import { handleCommandsAvailable } from './commands-available.js';
import { DEFAULT_SLASH_COMMANDS } from '../../shared/default-slash-commands.generated';

const silentLogger = { info: () => {}, warn: () => {} };

describe('handleCommandsAvailable', () => {
  it('persists trimmed catalog to DO metadata', async () => {
    const setAvailableCommands = vi.fn().mockResolvedValue(undefined);
    await handleCommandsAvailable(
      {
        commands: [
          { name: 'review', description: 'Review', template: 'BIG_TEMPLATE', hints: [] },
          { name: 'init', hints: ['$ARGUMENTS'], source: 'command' },
        ],
      },
      { setAvailableCommands, logger: silentLogger }
    );

    expect(setAvailableCommands).toHaveBeenCalledTimes(1);
    expect(setAvailableCommands).toHaveBeenCalledWith([
      { name: 'review', description: 'Review', hints: [] },
      { name: 'init', hints: ['$ARGUMENTS'], source: 'command' },
    ]);
  });

  it('drops items missing a name without rejecting the whole event', async () => {
    const setAvailableCommands = vi.fn().mockResolvedValue(undefined);
    await handleCommandsAvailable(
      { commands: [{ name: 'ok', hints: [] }, { template: 'no-name' }] },
      { setAvailableCommands, logger: silentLogger }
    );

    expect(setAvailableCommands).toHaveBeenCalledWith([{ name: 'ok', hints: [] }]);
  });

  it('warns and skips when commands array is missing', async () => {
    const setAvailableCommands = vi.fn();
    const warn = vi.fn();
    await handleCommandsAvailable(
      { not: 'a catalog' },
      { setAvailableCommands, logger: { info: () => {}, warn } }
    );

    expect(setAvailableCommands).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('handles undefined data gracefully', async () => {
    const setAvailableCommands = vi.fn();
    await handleCommandsAvailable(undefined, {
      setAvailableCommands,
      logger: { info: () => {}, warn: () => {} },
    });
    expect(setAvailableCommands).not.toHaveBeenCalled();
  });

  it('persists defaults when wrapper reports empty list', async () => {
    const setAvailableCommands = vi.fn().mockResolvedValue(undefined);
    await handleCommandsAvailable({ commands: [] }, { setAvailableCommands, logger: silentLogger });

    expect(setAvailableCommands).toHaveBeenCalledTimes(1);
    expect(setAvailableCommands).toHaveBeenCalledWith(DEFAULT_SLASH_COMMANDS);
  });

  it('persists defaults when all items fail validation', async () => {
    const setAvailableCommands = vi.fn().mockResolvedValue(undefined);
    await handleCommandsAvailable(
      { commands: [{ template: 'no-name' }, null, 42] },
      { setAvailableCommands, logger: silentLogger }
    );

    expect(setAvailableCommands).toHaveBeenCalledTimes(1);
    expect(setAvailableCommands).toHaveBeenCalledWith(DEFAULT_SLASH_COMMANDS);
  });
});
