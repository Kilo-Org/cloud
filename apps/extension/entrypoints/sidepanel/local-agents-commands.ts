import { browser } from '#imports';
import {
  LOCAL_AGENTS_COMMAND_MESSAGE,
  localAgentCommandResponseSchema,
} from '@/src/shared/local-agents/commands';

export type LocalAgentsCommand =
  | { kind: 'stop_all' }
  | { controllerId: string; kind: 'disconnect' };

export const LOCAL_AGENTS_COMMAND_ERRORS = {
  disconnect: "Couldn't disconnect the agent. Try again.",
  stop_all: "Couldn't stop the agents. Try again.",
} satisfies Record<LocalAgentsCommand['kind'], string>;

/** An unreadable answer counts as a failure: only `{ ok: true }` proves the background ran the command. */
export const sendLocalAgentCommand = async (command: LocalAgentsCommand): Promise<boolean> => {
  try {
    const response = localAgentCommandResponseSchema.safeParse(
      await browser.runtime.sendMessage({ ...command, type: LOCAL_AGENTS_COMMAND_MESSAGE })
    );

    return response.success && response.data.ok;
  } catch {
    return false;
  }
};
