const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/i/v0/e/';
const POSTHOG_TIMEOUT_MS = 5_000;

type CaptureEvent = {
  apiKey: string;
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
};

/**
 * Send a single event to PostHog's capture API.
 *
 * Direct fetch with a 5s timeout — no SDK, no timers, no queues.
 * Designed for fire-and-forget use inside `waitUntil`.
 */
export async function capturePostHogEvent({
  apiKey,
  distinctId,
  event,
  properties,
}: CaptureEvent): Promise<void> {
  const response = await fetch(POSTHOG_CAPTURE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
    body: JSON.stringify({
      api_key: apiKey,
      distinct_id: distinctId,
      event,
      properties: {
        ...properties,
        $lib: 'kiloclaw-worker',
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`PostHog capture failed (${response.status}): ${body.slice(0, 256)}`);
  }

  // Consume body to avoid Cloudflare Workers leaked response warnings.
  await response.text().catch(() => {});
}
