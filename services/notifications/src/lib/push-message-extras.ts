/**
 * OS-level presentation extras derived from a push's `data` blob.
 *
 * Two Expo message fields are not part of `data`:
 *   - `categoryId`: the OS notification category. iOS reads it as the
 *     `UNNotificationCategory` that supplies the notification's action
 *     buttons; Android receives the same field alongside the channel id.
 *   - `interruptionLevel`: iOS delivery priority. A needs-input raise is
 *     `time-sensitive` so it breaks through Focus/quiet delivery, while
 *     ordinary agent progress stays quiet at the platform default.
 *
 * Attention pushes get both; every other push gets an empty object, so the
 * emitted message is unchanged for chat, lifecycle, balance, security, and
 * ordinary agent status.
 *
 * A producer that predates `attentionKind` still sets `category: 'attention'`
 * but omits the kind. That must never throw: the kind defaults to `unknown`
 * (the action set that offers every answer) and the push stays time-sensitive.
 */
import { needsInputCategoryId, type PushData } from '@kilocode/notifications';

export type ExpoPushExtras = {
  categoryId?: string;
  interruptionLevel?: 'time-sensitive';
};

export function expoPushExtrasForPushData(data: PushData): ExpoPushExtras {
  if (data.type !== 'cloud_agent_session' || data.category !== 'attention') {
    return {};
  }

  return {
    categoryId: needsInputCategoryId({
      kind: data.attentionKind ?? 'unknown',
      hasPr: data.prUrl != null,
    }),
    interruptionLevel: 'time-sensitive',
  };
}
