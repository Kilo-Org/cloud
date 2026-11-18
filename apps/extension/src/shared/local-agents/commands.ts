import { z } from 'zod';

/*
 * Commands the side panel sends to the background. Every other UI surface uses
 * the tab-debugger message path; local agents keep their own message so the
 * browser-runtime refactor can move it independently.
 */

export const LOCAL_AGENTS_COMMAND_MESSAGE = 'kilo-local-agents-command';
export const STOP_ALL_LOCAL_AGENTS_COMMAND = 'stop-all-local-agents';
export const LOCAL_AGENTS_WATCHDOG_ALARM = 'kilo-local-agents-watchdog';

export const localAgentPanelCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    controllerId: z.uuid(),
    kind: z.literal('disconnect'),
    type: z.literal(LOCAL_AGENTS_COMMAND_MESSAGE),
  }),
  z.object({
    kind: z.literal('stop_all'),
    type: z.literal(LOCAL_AGENTS_COMMAND_MESSAGE),
  }),
]);

export type LocalAgentPanelCommand = z.infer<typeof localAgentPanelCommandSchema>;

export const localAgentCommandResponseSchema = z.object({ ok: z.boolean() });

export type LocalAgentCommandResponse = z.infer<typeof localAgentCommandResponseSchema>;
