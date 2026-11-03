import 'server-only';
import type { PreparationAttempt } from '@kilocode/cloud-agent-sdk';
import type { User } from '@kilocode/db/schema';
import { createControlTokenForRequest } from '@/lib/auth/resource-delegation';
import { createCloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';

export type FirstPageStreamState = {
  /** The latest stored event id, so the first connect replays from it. */
  watermarkEventId: number | null;
  /** The preparation rows the stream replays first, so the page shows them. */
  preparationAttempts: PreparationAttempt[];
};

/**
 * Reads the stream state a session's first transcript page carries. Each read
 * fails open to an empty value: the stream still delivers both later.
 */
export async function readFirstPageStreamState(
  ctx: { user: User; headersList?: Headers | undefined },
  organizationId: string | null,
  cloudAgentSessionId: string
): Promise<FirstPageStreamState> {
  let client: ReturnType<typeof createCloudAgentNextClient>;
  try {
    const { token } = await createControlTokenForRequest(ctx.user, 'cloud-agent-next', {
      headers: ctx.headersList,
      organizationId: organizationId ?? undefined,
      tokenSource: 'cloud-agent',
    });
    client = createCloudAgentNextClient(token);
  } catch (error) {
    warn('control token', cloudAgentSessionId, error);
    return { watermarkEventId: null, preparationAttempts: [] };
  }

  const [watermarkEventId, preparationAttempts] = await Promise.all([
    client.getSession(cloudAgentSessionId).then(
      session => session.latestEventId ?? null,
      (error: unknown) => {
        warn('watermark', cloudAgentSessionId, error);
        return null;
      }
    ),
    // A worker without this read rejects it; the stream still sends the rows.
    client.getPreparationAttempts(cloudAgentSessionId).catch((error: unknown) => {
      warn('preparation attempts', cloudAgentSessionId, error);
      return [];
    }),
  ]);
  return { watermarkEventId, preparationAttempts };
}

function warn(read: string, cloudAgentSessionId: string, error: unknown): void {
  console.warn(
    `Failed to fetch ${read} for session ${cloudAgentSessionId}:`,
    error instanceof Error ? error.message : error
  );
}
