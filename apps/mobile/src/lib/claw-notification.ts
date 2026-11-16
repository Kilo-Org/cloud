import { type PushData } from '@kilocode/notifications/schemas';

/**
 * Where a KiloClaw push lands now that KiloClaw has no mobile screen.
 *
 * The server keeps sending the three KiloClaw kinds to every Expo token
 * because store builds that still have the KiloClaw screens are installed, so
 * this app opens the matching Kilo web page in the in-app browser instead of
 * dropping the tap.
 *
 * The payloads name no organization — an instance and a conversation belong
 * either to the personal scope or to an organization, and the server never
 * says which — so every destination is the personal page. The web's own
 * instance status resolves the signed-in account's active instance there. An
 * organization conversation opened on the personal page shows "Conversation
 * not found" and returns to the chat list; that is the cost of a payload that
 * cannot identify its organization.
 *
 * A chat message opens its conversation. A lifecycle or scheduled-action event
 * opens the instance page, which redirects to the chat when the instance is
 * ready and to the create page when it is not, so a failed start also lands
 * somewhere useful.
 */
export function clawNotificationWebPath(data: PushData): string | null {
  if (data.type === 'chat.message') {
    return `/claw/chat/${encodeURIComponent(data.conversationId)}`;
  }
  if (data.type === 'instance-lifecycle' || data.type === 'scheduled-action') {
    return '/claw';
  }
  return null;
}

/** The absolute web page a KiloClaw push opens, or null for any other push. */
export function clawNotificationWebUrl(data: PushData, webBaseUrl: string): string | null {
  const path = clawNotificationWebPath(data);
  if (path === null) {
    return null;
  }
  const baseUrl = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  return `${baseUrl}${path}`;
}

/**
 * Open a KiloClaw destination in the in-app browser, with the retry toast a
 * link that failed to open offers. Loaded lazily: the notification modules are
 * evaluated in a headless task start too, and only a tap reaches a browser.
 */
export async function openClawNotificationWebUrl(url: string): Promise<void> {
  const { openExternalUrl } = await import('./external-link');
  await openExternalUrl(url, { retryOnError: true });
}
