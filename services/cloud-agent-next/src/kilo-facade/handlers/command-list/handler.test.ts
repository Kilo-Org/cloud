import { describe, expect, it, vi } from 'vitest';
import { commandsOrDefault } from '../../../shared/slash-commands.js';
import type { KiloFacadeHandlerContext } from '../../contracts.js';
import { handleCommandList } from './handler.js';

const kiloSessionId = 'ses_12345678901234567890123456';
const directory = `/cloud-agent/sessions/${kiloSessionId}`;

function commandListContext(search = `?directory=${directory}`): {
  context: KiloFacadeHandlerContext;
  getAvailableCommands: ReturnType<typeof vi.fn>;
  resolveRoot: ReturnType<typeof vi.fn>;
} {
  const request = new Request(`https://facade.test/kilo/command${search}`);
  const getAvailableCommands = vi.fn().mockResolvedValue([
    {
      name: 'init',
      description: 'initialize repository instructions',
      source: 'command',
      hints: ['optional focus'],
      agent: 'code',
      model: 'anthropic/claude-sonnet-4',
      subtask: false,
    },
  ]);
  const resolveRoot = vi.fn().mockResolvedValue({ cloudAgentSessionId: 'cloud-root' });
  return {
    context: {
      request,
      env: {} as KiloFacadeHandlerContext['env'],
      userId: 'user-1',
      url: new URL(request.url),
      kiloPath: '/command',
      deps: { resolveRootSessionForKiloSession: resolveRoot, getAvailableCommands },
    },
    getAvailableCommands,
    resolveRoot,
  };
}

describe('command list handler', () => {
  it('returns cached command metadata with an empty compatibility template', async () => {
    const { context, getAvailableCommands } = commandListContext();

    const response = await handleCommandList(context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        name: 'init',
        description: 'initialize repository instructions',
        source: 'command',
        hints: ['optional focus'],
        agent: 'code',
        model: 'anthropic/claude-sonnet-4',
        subtask: false,
        template: '',
      },
    ]);
    expect(getAvailableCommands).toHaveBeenCalledWith({
      env: context.env,
      userId: 'user-1',
      cloudAgentSessionId: 'cloud-root',
    });
  });

  it('reads cold generated defaults through the production session DO seam', async () => {
    const { context } = commandListContext();
    const getAvailableCommands = vi.fn().mockResolvedValue(commandsOrDefault(undefined));
    context.deps = {
      resolveRootSessionForKiloSession: async () => ({ cloudAgentSessionId: 'cloud-root' }),
    };
    context.env = {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'session-do-id'),
        get: vi.fn(() => ({ getAvailableCommands })),
      },
    } as unknown as KiloFacadeHandlerContext['env'];

    const response = await handleCommandList(context);
    const commands = (await response.json()) as Array<{ name: string; template: string }>;

    expect(response.status).toBe(200);
    expect(commands.some(command => command.name === 'init')).toBe(true);
    expect(commands.some(command => command.name === 'compact')).toBe(true);
    expect(commands.every(command => command.template === '')).toBe(true);
    expect(getAvailableCommands).toHaveBeenCalledOnce();
  });

  it.each([
    '',
    '?workspace=/private/workspace',
    '?directory=/private/workspace',
    '?unknown=x',
    `?directory=${encodeURIComponent(directory)}&directory=${encodeURIComponent(directory)}`,
  ])('requires exactly one public directory selector for %s', async search => {
    const { context, getAvailableCommands } = commandListContext(search);

    const response = await handleCommandList(context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_SELECTOR_UNSUPPORTED',
    });
    expect(getAvailableCommands).not.toHaveBeenCalled();
  });

  it('returns public not-found for an unowned selected root', async () => {
    const { context, resolveRoot, getAvailableCommands } = commandListContext();
    resolveRoot.mockResolvedValue(null);

    const response = await handleCommandList(context);

    expect(response.status).toBe(404);
    expect(getAvailableCommands).not.toHaveBeenCalled();
  });

  it('sanitizes command catalog read failures', async () => {
    const { context, getAvailableCommands } = commandListContext();
    getAvailableCommands.mockRejectedValue(new Error('private durable object details'));

    const response = await handleCommandList(context);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_COMMAND_LIST_FAILED',
      message: 'Kilo command catalog is temporarily unavailable',
    });
  });
});
