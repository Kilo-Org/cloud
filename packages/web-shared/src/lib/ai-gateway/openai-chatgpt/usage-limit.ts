import * as z from 'zod';

/**
 * Detection for the ChatGPT plan usage limit.
 *
 * OpenAI answers a delegated request that outran the plan allowance with HTTP
 * 429 and a small metadata body. The gateway writes that event to the
 * connection row, and the web app reads it on the next page load so it can show
 * the partner guideline's usage-limit modal. The error body itself is passed
 * through to the caller unchanged: the client still sees the upstream failure.
 *
 * The recorded event is a notice, never a gate: requests keep reaching OpenAI,
 * which is the only authority on when the allowance returns. A request that
 * then succeeds clears the record, because OpenAI reports no reset time for an
 * app-specific limit and a reset the person applies in ChatGPT can restore the
 * allowance before the recorded window ends.
 *
 * Only a plan limit counts. A per-minute rate limit (`rate_limit_exceeded`)
 * clears on its own and must not tell a person their plan allowance ran out.
 */

/**
 * The ChatGPT usage settings page. The partner guideline requires the
 * usage-limit notice to open this page, and it is the only place that shows
 * both the plan allowance and the weekly limit a person set for this app. An
 * app-specific limit can be exhausted while the plan still has allowance, so
 * the Codex-only dashboard would not name the limit that blocked the request.
 */
export const CHATGPT_USAGE_SETTINGS_URL = 'https://chatgpt.com/settings/usage';

/** The only status that carries a plan limit. */
const USAGE_LIMIT_STATUS = 429;

/**
 * The upstream markers that mean the plan allowance is spent. `detail` is the
 * ChatGPT backend shape and `error` is the API shape, so both are read. The
 * `subscription_sharing_*` code is the documented one for this integration; it
 * covers both the plan allowance and an app-specific weekly limit, which can be
 * exhausted while the plan still has allowance.
 */
const USAGE_LIMIT_MARKERS: Record<string, true> = {
  usage_limit_reached: true,
  insufficient_quota: true,
  subscription_sharing_usage_limit_exceeded: true,
};

/**
 * How long a recorded limit stays visible when OpenAI reported no reset delay.
 * ChatGPT plan limits apply over a five-hour and a weekly window, so the
 * shorter window is the longest a record can be trusted without a reset time.
 * A longer window would keep the message up after the allowance came back.
 */
export const USAGE_LIMIT_UNKNOWN_RESET_WINDOW_MS = 5 * 60 * 60 * 1000;

const usageLimitMetadataSchema = z.object({
  type: z.string().optional(),
  code: z.string().optional(),
  resets_in_seconds: z.number().finite().nonnegative().optional(),
});

const usageLimitEnvelopeSchema = z.object({
  detail: usageLimitMetadataSchema.optional(),
  error: usageLimitMetadataSchema.optional(),
});

/** What the gateway recorded about a plan limit. */
export type ChatGptUsageLimit = {
  /** Epoch milliseconds when the limit resets, or null when OpenAI gave none. */
  resetsAt: number | null;
};

/**
 * Reads a plan limit out of an upstream failure. Returns null for every other
 * status, body, or marker, so a caller can record the event unconditionally.
 */
export function readChatGptUsageLimit(
  status: number,
  body: unknown,
  now: number = Date.now()
): ChatGptUsageLimit | null {
  if (status !== USAGE_LIMIT_STATUS) return null;

  const parsed = usageLimitEnvelopeSchema.safeParse(body);
  if (!parsed.success) return null;

  const metadata = parsed.data.detail ?? parsed.data.error;
  if (!metadata) return null;

  const isPlanLimit = [metadata.type, metadata.code].some(
    marker => marker !== undefined && USAGE_LIMIT_MARKERS[marker] === true
  );
  if (!isPlanLimit) return null;

  const resetsInSeconds = metadata.resets_in_seconds;
  return {
    resetsAt: resetsInSeconds === undefined ? null : now + Math.round(resetsInSeconds * 1000),
  };
}

/**
 * Whether a recorded limit is still current. An expired record stays in the row
 * and is ignored here instead of being cleared, so the read path never writes
 * and the next limit event, a successful request, or a reconnect overwrites it.
 */
export function isChatGptUsageLimitCurrent(
  reachedAt: string | Date | null | undefined,
  resetsAt: string | Date | null | undefined,
  now: number = Date.now()
): boolean {
  const reached = toEpochMilliseconds(reachedAt);
  if (reached === null) return false;

  const resets = toEpochMilliseconds(resetsAt);
  const expiresAt = resets ?? reached + USAGE_LIMIT_UNKNOWN_RESET_WINDOW_MS;
  return now < expiresAt;
}

/**
 * Reads a stored timestamp. PostgreSQL returns `2026-04-29 01:16:12.945+00`,
 * which `Date.parse` accepts, and Drizzle's string mode can also hand back the
 * ISO string a caller wrote.
 */
function toEpochMilliseconds(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}
