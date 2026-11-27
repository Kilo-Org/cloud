import { z } from 'zod';
import type { TurnstileSettings } from '../providers/config';

/**
 * The server-side Turnstile check of the email start form (design 5.3): a scripted flood cannot
 * make UTS fill an address's inbox. The widget on the sign-in page puts a token in the form's
 * `cf-turnstile-response` field; UTS sends it once to Cloudflare's siteverify API
 * (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) and accepts
 * it only when Cloudflare says it passed, for this form's action, on the issuer's own host.
 *
 * | Outcome | When | Page |
 * |---|---|---|
 * | `passed` | `success` true, action and hostname match | the start goes on |
 * | `refused` | no token, a forged, expired or reused token, another action or host | 400 |
 * | `retryable` | siteverify did not answer, answered 5xx or not JSON, or `internal-error` | 503 |
 * | `misconfigured` | Cloudflare refused the secret | 500 |
 *
 * The log line carries the outcome and Cloudflare's fixed error codes, never the token or secret.
 */

export const TURNSTILE_RESPONSE_FIELD = 'cf-turnstile-response';
/** The widget's `data-action`; siteverify echoes it, so a token from another form is refused. */
export const TURNSTILE_ACTION = 'email-sign-in';
const MAX_TOKEN_LENGTH = 2048;
/**
 * Siteverify answers in tens of milliseconds; the start waits for it and then for Mailgun (10 s,
 * `PROVIDER_TIMEOUT_MS`), so it gets 3 s of its own and counts as retryable after that.
 */
const TURNSTILE_TIMEOUT_MS = 3_000;

export type TurnstileOutcome = 'passed' | 'refused' | 'retryable' | 'misconfigured';
export type TurnstileCheck = (
  token: string | null,
  clientIp: string | null
) => Promise<TurnstileOutcome>;

const SiteverifySchema = z.object({
  success: z.boolean(),
  'error-codes': z.array(z.string()).default([]),
  hostname: z.string().optional(),
  action: z.string().optional(),
});

const SECRET_ERRORS: readonly string[] = ['missing-input-secret', 'invalid-input-secret'];
const ERROR_CODE = /^[a-z-]{1,40}$/;

function settle(outcome: TurnstileOutcome, reason: string, errorCodes: readonly string[] = []) {
  const line = JSON.stringify({
    event: 'uts.signin.turnstile',
    outcome,
    reason,
    errorCodes: errorCodes.filter(code => ERROR_CODE.test(code)).slice(0, 5),
  });
  if (outcome === 'passed') console.log(line);
  else console.error(line);
  return outcome;
}

/** `fetcher` is the platform `fetch` in a Worker and a stand-in in tests. */
export function turnstileCheck(
  settings: TurnstileSettings,
  expectedHostname: string,
  fetcher: typeof fetch
): TurnstileCheck {
  return async (token, clientIp) => {
    if (token === null || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return settle('refused', 'no_token');
    }
    const body = new URLSearchParams({ secret: settings.secretKey, response: token });
    if (clientIp !== null) body.set('remoteip', clientIp);
    let response: Response;
    try {
      response = await fetcher(settings.verifyUrl, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
      });
    } catch {
      return settle('retryable', 'unreachable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      return settle('retryable', `status_${response.status}`);
    }
    const answer = SiteverifySchema.safeParse(await response.json().catch(() => undefined));
    if (!answer.success) return settle('retryable', 'invalid_answer');
    const errorCodes = answer.data['error-codes'];
    if (!answer.data.success) {
      if (errorCodes.some(code => SECRET_ERRORS.includes(code))) {
        return settle('misconfigured', 'secret_refused', errorCodes);
      }
      if (errorCodes.includes('internal-error')) {
        return settle('retryable', 'internal_error', errorCodes);
      }
      return settle('refused', 'not_passed', errorCodes);
    }
    if (answer.data.action !== TURNSTILE_ACTION) return settle('refused', 'other_action');
    if (answer.data.hostname !== expectedHostname) return settle('refused', 'other_hostname');
    return settle('passed', 'passed');
  };
}
