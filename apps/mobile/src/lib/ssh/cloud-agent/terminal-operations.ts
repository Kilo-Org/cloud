import { trpcClient } from '@/lib/trpc';

import { type TerminalOperations } from './terminal-connection';

type TerminalTarget = Readonly<{
  cloudAgentSessionId: string;
  /** The session's organization; absent for a personal session. */
  organizationId?: string;
}>;

/**
 * A resize and a close are fire-and-forget: the socket is the terminal's
 * liveness, a resize the Worker missed is corrected by the next one, and a pty
 * left behind is reaped with its sandbox. A refusal is therefore dropped rather
 * than surfaced, and this is the one place that drops one.
 */
async function settle(request: Promise<unknown>): Promise<void> {
  try {
    await request;
  } catch {
    // Dropped on purpose: see above.
  }
}

/**
 * The four control-plane calls a terminal is made of, against the router that
 * owns the session. The personal and organization routers expose the same
 * underlying calls, so only the client they are read from differs.
 */
export function terminalOperations({
  cloudAgentSessionId,
  organizationId,
}: TerminalTarget): TerminalOperations {
  const personal = trpcClient.cloudAgentNext;
  const organization = trpcClient.organizations.cloudAgentNext;

  return {
    create: async size => {
      const result =
        organizationId === undefined
          ? await personal.createTerminal.mutate({
              cloudAgentSessionId,
              ...size,
            })
          : await organization.createTerminal.mutate({
              cloudAgentSessionId,
              organizationId,
              ...size,
            });
      return { ptyId: result.ptyId, wsUrl: result.wsUrl };
    },
    refreshTicket: async ({ ptyId }) => {
      const result =
        organizationId === undefined
          ? await personal.refreshTerminalTicket.mutate({ cloudAgentSessionId, ptyId })
          : await organization.refreshTerminalTicket.mutate({
              cloudAgentSessionId,
              ptyId,
              organizationId,
            });
      return { wsUrl: result.wsUrl };
    },
    resize: ({ ptyId, cols, rows }) => {
      const input = { cloudAgentSessionId, ptyId, cols, rows };
      const request =
        organizationId === undefined
          ? personal.resizeTerminal.mutate(input)
          : organization.resizeTerminal.mutate({ ...input, organizationId });
      void settle(request);
    },
    close: ({ ptyId }) => {
      const input = { cloudAgentSessionId, ptyId };
      const request =
        organizationId === undefined
          ? personal.closeTerminal.mutate(input)
          : organization.closeTerminal.mutate({ ...input, organizationId });
      void settle(request);
    },
  };
}
