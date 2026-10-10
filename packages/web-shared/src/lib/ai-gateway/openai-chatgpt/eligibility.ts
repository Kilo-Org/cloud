import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import {
  OPENAI_CHATGPT_API_KEY_ENV,
  OPENAI_CHATGPT_API_URL,
  OPENAI_ON_BEHALF_OF_TOKEN_HEADER,
  withTraceabilityMetadata,
} from './routing';
import { isOpenAiModelServed } from './served-models';

/**
 * Detection for an account OpenAI refuses to share a plan for.
 *
 * OpenAI returns `403 subscription_sharing_user_not_eligible` when ChatGPT plan
 * usage is unavailable for the selected user, workspace, or policy. Its
 * "Errors and recovery" reference says to explain the restriction and not to
 * repeat the request or loop through OAuth: every later request on the same
 * account fails the same way, and so does a reconnect to the same account.
 */

const NOT_ELIGIBLE_STATUS = 403;
const NOT_ELIGIBLE_CODE = 'subscription_sharing_user_not_eligible';

/**
 * Shown on the connection card after OpenAI refused the connected account. The
 * refused row is disabled, so later requests take the ordinary Kilo route.
 */
export const OPENAI_CHATGPT_NOT_ELIGIBLE_MESSAGE =
  "OpenAI doesn't allow this ChatGPT account or workspace to share its plan. Connect a different ChatGPT account; until then, requests use Kilo credits.";

/** Whether an upstream failure says the connected account is not eligible. */
export function isChatGptUserNotEligible(status: number, body: unknown): boolean {
  if (status !== NOT_ELIGIBLE_STATUS) return false;
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const error = body.error;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === NOT_ELIGIBLE_CODE
  );
}

/**
 * The model the connect probe asks for. OpenAI checks the model before the
 * account, so the probe must name a model the partner project serves; OpenAI's
 * own inference example uses this one.
 */
const PROBE_MODEL = 'gpt-6.1-sol';

/** A slow probe must not hold up the sign-in callback for long. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Asks OpenAI whether the freshly connected account may share its plan.
 * OpenAI documents no eligibility endpoint; the refusal arrives only on a
 * Responses request, so the probe sends the smallest one. Returns `false` only
 * for the documented refusal. Every other outcome, including a usage limit, an
 * outage, a timeout or a missing partner key, returns `true`: the request-time
 * check in the gateway still catches a refusal later.
 */
export async function probeOpenAiChatGptEligibility(accessToken: string): Promise<boolean> {
  const apiKey = getEnvVariable(OPENAI_CHATGPT_API_KEY_ENV);
  if (apiKey.trim() === '') return true;

  try {
    if (!(await isOpenAiModelServed(apiKey, PROBE_MODEL))) return true;

    const response = await fetch(`${OPENAI_CHATGPT_API_URL}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        [OPENAI_ON_BEHALF_OF_TOKEN_HEADER]: accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        input: 'Reply with OK.',
        max_output_tokens: 16,
        store: false,
        stream: true,
        metadata: withTraceabilityMetadata(null, null),
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (response.status !== NOT_ELIGIBLE_STATUS) {
      // Only the status matters; stop the stream instead of reading it.
      await response.body?.cancel();
      return true;
    }
    return !isChatGptUserNotEligible(response.status, await response.json());
  } catch {
    return true;
  }
}
