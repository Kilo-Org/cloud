/**
 * OS-level presentation extras derived from a push's `data` blob.
 *
 * Three Expo message fields are not part of `data`:
 *   - `categoryId`: the OS notification category. iOS reads it as the
 *     `UNNotificationCategory` that supplies the notification's action
 *     buttons; Android receives the same field alongside the channel id.
 *   - `interruptionLevel`: iOS delivery priority. A needs-input raise is
 *     `time-sensitive` so it breaks through Focus/quiet delivery, while
 *     ordinary agent progress stays quiet at the platform default.
 *   - `threadId`: iOS thread (`aps.thread-id`). Notifications that share it are
 *     stacked into one Notification Center group; unlike `collapseId`, none of
 *     them is replaced or removed.
 *
 * Attention pushes get the category and the level but no thread: their actions
 * must stay directly reachable, so they are never folded into a progress group.
 * Every other `cloud_agent_session` push joins its own session's thread, which
 * is what groups repeated progress/status alerts for one session. Every other
 * push type gets an empty object, so the emitted message is unchanged for chat,
 * lifecycle, balance, security, briefing, and glanceable delivery.
 *
 * A producer that predates `attentionKind` still sets `category: 'attention'`
 * but omits the kind. That must never throw: the kind defaults to `unknown`
 * (the action set that offers every answer) and the push stays time-sensitive.
 */
import { needsInputCategoryId, type PushData } from '@kilocode/notifications';

export type ExpoPushExtras = {
  categoryId?: string;
  interruptionLevel?: 'time-sensitive';
  threadId?: string;
};

/**
 * Namespace mixed into the hashed thread key. Changing it re-groups every
 * existing notification, so it is a constant, not a tuning knob.
 */
const IOS_THREAD_KEY_NAMESPACE = 'kilo-ios-agent-session';

/**
 * Hex characters kept from the digest. 32 hex characters (128 bits) make an
 * accidental collision between two of a user's sessions negligible while the
 * key stays short on the wire.
 */
const IOS_THREAD_KEY_HEX_LENGTH = 32;

/**
 * The thread key of one account's session, or `undefined` when the push carries
 * no session identity to group by.
 *
 * The key is the truncated SHA-256 of the account id and the CLI session id
 * together, so a second account's session of the same id lands in a different
 * thread while neither identifier reaches the device: `threadId` travels to
 * APNs and, through the client, into the system's notification database.
 */
async function iosThreadIdForSession(
  sessionId: string,
  accountId: string
): Promise<string | undefined> {
  if (!sessionId || !accountId) {
    return undefined;
  }

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([IOS_THREAD_KEY_NAMESPACE, accountId, sessionId]))
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, IOS_THREAD_KEY_HEX_LENGTH);
}

export async function expoPushExtrasForPushData(
  data: PushData,
  accountId: string
): Promise<ExpoPushExtras> {
  if (data.type !== 'cloud_agent_session') {
    return {};
  }

  if (data.category === 'attention') {
    return {
      categoryId: needsInputCategoryId({
        kind: data.attentionKind ?? 'unknown',
        hasPr: data.prUrl != null,
      }),
      interruptionLevel: 'time-sensitive',
    };
  }

  // Absent `category` is the rolling-deploy default of status, so an old
  // producer's progress push joins the thread too.
  const threadId = await iosThreadIdForSession(data.cliSessionId, accountId);
  return threadId === undefined ? {} : { threadId };
}
