import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { trpcClient } from '@/lib/trpc';

import { resolveAnsweredRaises } from './attention-rows';
import { createGlanceablePublisher } from './create-publisher';
import { type GlanceablePublisherContext } from './publisher';
import { getGlanceableSinks } from './sink-registry';

/**
 * Read the tray once and publish it to every registered sink, for the periodic
 * background refresh (`glanceable-refresh-task.ts`). The data-only glanceable
 * push is the primary carrier; this read corrects the surfaces when the OS
 * dropped or throttled that push.
 *
 * A fresh publisher lets its first write through, so the sinks reconcile the
 * native surfaces this process did not start. It is built before the fetch:
 * it captures the terminal-blank epoch at construction, so a sign-out that
 * lands during the read wins the surface. The counts are the ack-resolved
 * ones, like every other republish path. A failed fetch rejects before any
 * write: the last published snapshot stays, and nothing is invented.
 *
 * The task's process can end as soon as this resolves, so it waits for the
 * native start or terminal submission. A native failure rejects, which the
 * task reports to the OS as a failed run.
 */
export async function publishTrayOnce(ctx: GlanceablePublisherContext): Promise<void> {
  const publisher = createGlanceablePublisher();
  const { sessions } = await trpcClient.activeSessions.list.query(
    buildActiveSessionsTrayInput(ctx.organizationId)
  );
  publisher.handleSessions(resolveAnsweredRaises(sessions), ctx);
  await Promise.all(
    getGlanceableSinks().flatMap(sink => [
      sink.waitForNativeStart?.(),
      sink.waitForNativeTerminal?.(),
    ])
  );
}
