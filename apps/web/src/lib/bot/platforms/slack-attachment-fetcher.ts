/** How long an authorized attachment fetch waits for response headers. */
const SLACK_ATTACHMENT_HEADER_TIMEOUT_MS = 15_000;

/**
 * Slack serves its private files from its own HTTPS hosts, and only those hosts
 * may receive the installation's bot token.
 */
export function isSlackFileUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com');
}

/**
 * Build the authorized fetch the bot layer uses to read a Slack attachment
 * under its size cap. The installation token is attached only for a Slack file
 * URL; any other URL is refused so the caller can fall back to the adapter's
 * own fetch. A stalled response header wait aborts, which the caller also
 * treats as a fallback.
 */
export function createSlackAttachmentUrlFetcher(
  botToken: string
): (url: string) => Promise<Response> {
  return async url => {
    if (!isSlackFileUrl(url)) {
      throw new Error('Refused an attachment URL outside the Slack file hosts');
    }

    const controller = new AbortController();
    const headerTimeout = setTimeout(() => controller.abort(), SLACK_ATTACHMENT_HEADER_TIMEOUT_MS);
    try {
      return await fetch(url, {
        headers: { Authorization: `Bearer ${botToken}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(headerTimeout);
    }
  };
}
