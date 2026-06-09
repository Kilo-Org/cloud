import type { Command } from '@kilocode/sdk/v2';
import type { CloudAgentSession } from '../../../persistence/CloudAgentSession.js';
import type { SlashCommandInfo } from '../../../shared/slash-commands.js';
import { withDORetry } from '../../../utils/do-retry.js';
import type { KiloFacadeHandlerContext } from '../../contracts.js';
import { facadeError } from '../../http-contract.js';
import { resolveSelectedOwnedRoot } from '../../ownership.js';

function projectCommand(command: SlashCommandInfo): Command {
  return {
    name: command.name,
    ...(command.description !== undefined ? { description: command.description } : {}),
    ...(command.agent !== undefined ? { agent: command.agent } : {}),
    ...(command.model !== undefined ? { model: command.model } : {}),
    ...(command.source !== undefined ? { source: command.source } : {}),
    ...(command.subtask !== undefined ? { subtask: command.subtask } : {}),
    hints: command.hints,
    // The runtime cache is intentionally metadata-only; Kilo expands commands by name.
    // This empty field satisfies the SDK shape and is not an executable public template.
    template: '',
  };
}

function readAvailableCommands(
  context: KiloFacadeHandlerContext,
  cloudAgentSessionId: string
): Promise<SlashCommandInfo[]> {
  if (context.deps?.getAvailableCommands) {
    return context.deps.getAvailableCommands({
      env: context.env,
      userId: context.userId,
      cloudAgentSessionId,
    });
  }
  const id = context.env.CLOUD_AGENT_SESSION.idFromName(`${context.userId}:${cloudAgentSessionId}`);
  return withDORetry<DurableObjectStub<CloudAgentSession>, SlashCommandInfo[]>(
    () => context.env.CLOUD_AGENT_SESSION.get(id),
    stub => stub.getAvailableCommands(),
    'getAvailableCommands'
  );
}

export async function handleCommandList(context: KiloFacadeHandlerContext): Promise<Response> {
  const owned = await resolveSelectedOwnedRoot(context);
  if (owned instanceof Response) return owned;

  try {
    const commands = await readAvailableCommands(context, owned.cloudAgentSessionId);
    return Response.json(commands.map(projectCommand));
  } catch {
    return facadeError(
      500,
      'KILO_COMMAND_LIST_FAILED',
      'Kilo command catalog is temporarily unavailable'
    );
  }
}
