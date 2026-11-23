import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { trpcClient } from '@/lib/trpc';

import { whenGlanceableAckHydrationSettled } from './ack-hydration';
import { whenAskBindingSettled } from './ask-binding';
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
 * ones, like every other republish path, and the derivation waits (bounded) for
 * the session-attention store to hydrate: this process did not answer a raise,
 * so before hydrating the store reads every raise as unanswered. A failed fetch
 * rejects before any write: the last published snapshot stays, and nothing is
 * invented.
 *
 * The task's process can end as soon as this resolves, so it waits for the
 * native start or terminal submission. A native failure rejects, which the
 * task reports to the OS as a failed run.
 */
export async function publishTrayOnce(ctx: GlanceablePublisherContext): Promise<void> {
  // One publisher per run: the binding wait below redraws it, and a
  // subscription would outlive the process in the module-level listener set.
  const publisher = createGlanceablePublisher({ context: ctx, redrawOnAskBound: false });
  // The settle wait runs beside the read, so the ack store's KV open costs this
  // run nothing when it is the slower of the two. It is bounded by
  // `ACK_HYDRATION_SETTLE_MS`; a store that never settles still derives.
  const [{ sessions }] = await Promise.all([
    trpcClient.activeSessions.list.query(buildActiveSessionsTrayInput(ctx.organizationId)),
    whenGlanceableAckHydrationSettled(),
  ]);
  publisher.handleSessions(resolveAnsweredRaises(sessions), ctx);
  // The surface reads the ask's request binding when it draws, and the select
  // above starts that read: wait for it and draw again, so the card this run
  // leaves behind offers Approve for the ask it names.
  await whenAskBindingSettled();
  publisher.redraw();
  await Promise.all(
    getGlanceableSinks()
      .flatMap(sink => [sink.waitForNativeStart?.(), sink.waitForNativeTerminal?.()])
      .filter((pending): pending is Promise<void> => pending !== undefined)
  );
}
