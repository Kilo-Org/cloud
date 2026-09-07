/**
 * The pending native ends the iOS sink has submitted but ActivityKit has not
 * settled yet. Only pending submissions live in JavaScript; native discovery
 * owns terminal visibility, so this map is empty again once each end lands.
 */
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';
import { after, type LiveActivity } from 'expo-widgets';

export type Activity = LiveActivity<Partial<GlanceableLiveActivityContentState>>;

type EndIntent = {
  /** Milliseconds ActivityKit retains the card, or null to dismiss it at once. */
  dismissMs: number | null;
  props: Partial<GlanceableLiveActivityContentState> | null;
};

export type EndingActivity = {
  id: string;
  instance: Activity;
  update: Promise<void> | null;
  token: Promise<string | null>;
  intent: EndIntent;
  pending: Promise<void> | null;
};

export const endingActivities = new Map<string, EndingActivity>();

export async function readEndingToken(instance: Activity): Promise<string | null> {
  try {
    return await instance.getPushToken();
  } catch {
    // Recorded tokens still need cleanup when the native lookup fails.
    return null;
  }
}

async function finishEnd(ending: EndingActivity): Promise<void> {
  let completed = false;
  try {
    try {
      await ending.update;
    } catch {
      // A rejected update must not block the end; its contentDate still advances.
    }
    await ending.token;
    // Read the latest intent at the native boundary. Privacy can supersede an
    // empty snapshot during either await, including an already-submitted end.
    // The retention window is measured from here, so the awaits never eat it.
    for (;;) {
      const intent = ending.intent;
      // eslint-disable-next-line no-await-in-loop -- serialize a privacy dismissal after an in-flight native end
      await ending.instance.end(
        intent.dismissMs === null ? 'immediate' : after(new Date(Date.now() + intent.dismissMs)),
        intent.props ?? undefined,
        new Date()
      );
      if (intent === ending.intent) {
        break;
      }
    }
    completed = true;
  } catch (error) {
    // Native reports missing IDs as dismissed; only confirmed absence settles a failed end.
    if (ending.instance.getInfo().state !== 'dismissed') {
      throw error;
    }
    completed = true;
  } finally {
    ending.pending = null;
    if (completed) {
      endingActivities.delete(ending.id);
    }
  }
}

export async function scheduleEnd(ending: EndingActivity): Promise<void> {
  // Await the in-flight task rather than returning early: a caller that waits on
  // this promise before starting a replacement needs the native end to have landed.
  const pending = ending.pending ?? (ending.pending = finishEnd(ending));
  try {
    await pending;
  } catch {
    // Foreground publication is best-effort; background callers await the original task.
  }
}

/** Await every submitted end. Separate from `scheduleEnd` so callers stay await-only. */
export async function settleEnds(pending: readonly Promise<void>[]): Promise<void> {
  await Promise.all(pending);
}

/**
 * End one activity the sink does not own, at once. Its push token belongs to
 * an earlier process or to a push-to-start, so no local token cleanup runs
 * here: the server drops the row when APNs reports the activity ended.
 */
export function endExtra(instance: Activity, id: string): void {
  const ending: EndingActivity = {
    id,
    instance,
    update: null,
    token: readEndingToken(instance),
    intent: { dismissMs: null, props: null },
    pending: null,
  };
  endingActivities.set(id, ending);
  void scheduleEnd(ending);
}
