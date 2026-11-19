import { browser } from '#imports';
import {
  LOCAL_AGENTS_COMMAND_MESSAGE,
  localAgentCommandResponseSchema,
} from '@/src/shared/local-agents/commands';

/* The commands the "Local agents" section sends to the background, and what each failure reads. */

export type LocalAgentsCommand =
  | { kind: 'stop_all' }
  | { controllerId: string; kind: 'disconnect' };

export const LOCAL_AGENTS_COMMAND_ERRORS = {
  disconnect: "Couldn't disconnect the agent. Try again.",
  stop_all: "Couldn't stop the agents. Try again.",
} satisfies Record<LocalAgentsCommand['kind'], string>;

/** True only when the background ran the command; no answer, or one it cannot read, is a failure. */
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
