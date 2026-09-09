/**
 * The pending native ends the iOS sink has submitted but ActivityKit has not
 * settled yet. Only pending submissions live in JavaScript; native discovery
 * owns terminal visibility, so this map is empty again once each end lands.
 */
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';
import { after, type LiveActivity } from 'expo-widgets';
import { AppState } from 'react-native';

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

let idleEndTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Temporary AppState watch for a pending idle-end debounce. JavaScript can
 * suspend the moment the app stops being active, so the timer would never
 * fire and the card would never retire. Leaving active submits the same end
 * at once; every other exit path removes the watch below.
 */
let idleEndAppState: { remove: () => void } | null = null;

function clearIdleEndAppState(): void {
  idleEndAppState?.remove();
  idleEndAppState = null;
}

export function cancelIdleEnd(): void {
  if (idleEndTimer !== null) {
    clearTimeout(idleEndTimer);
    idleEndTimer = null;
  }
  clearIdleEndAppState();
}

export function scheduleIdleEnd(end: () => void, delayMs: number): void {
  // Already inactive or background, JavaScript can suspend before any timer
  // fires: submit the idle end at once so a background caller can await it.
  if (AppState.currentState !== 'active') {
    end();
    return;
  }
  if (idleEndTimer !== null) {
    return;
  }
  idleEndTimer = setTimeout(() => {
    idleEndTimer = null;
    clearIdleEndAppState();
    end();
  }, delayMs);
  // While active, a later transition out of active must flush the pending end
  // before iOS suspends the JavaScript context. Every other exit path above
  // and in `cancelIdleEnd` removes this watch.
  idleEndAppState = AppState.addEventListener('change', state => {
    if (state === 'active' || idleEndTimer === null) {
      return;
    }
    clearTimeout(idleEndTimer);
    idleEndTimer = null;
    clearIdleEndAppState();
    end();
  });
}

export function endOtherVisible(keptId: string, instances: readonly Activity[]): void {
  for (const instance of instances) {
    const id = instance.getInfo().id;
    if (id !== keptId && instance.getInfo().state !== 'dismissed') {
      endExtra(instance, id);
    }
  }
}
