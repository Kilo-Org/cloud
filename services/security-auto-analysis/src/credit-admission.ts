import { z } from 'zod';
import { logger } from './logger.js';

const PeerAnalysisCreditAdmissionSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('admitted') }),
  z.object({ outcome: z.literal('insufficient_credits'), message: z.string() }),
  z.object({ outcome: z.literal('unavailable'), message: z.string() }),
]);

/**
 * The peer's three answers plus `refused`, which this service produces itself
 * from an authorization-status answer so the caller gets a typed outcome
 * instead of matching message text.
 */
export const AnalysisCreditAdmissionSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('admitted') }),
  z.object({ outcome: z.literal('insufficient_credits'), message: z.string() }),
  z.object({ outcome: z.literal('unavailable'), message: z.string() }),
  z.object({ outcome: z.literal('refused'), message: z.string() }),
]);

export type AnalysisCreditAdmission = z.infer<typeof AnalysisCreditAdmissionSchema>;

const CreditAdmissionResponseSchema = z.object({
  result: z.object({ data: PeerAnalysisCreditAdmissionSchema }),
});

/**
 * Reads the Cloud Agent peer's analysis credit decision before this service
 * runs a triage model call and prepares a Cloud Agent session. The peer's
 * existing balance rule decides; nothing is re-derived here and the
 * initiate-time 402 stays authoritative.
 *
 * A `refused` answer is a permanent authorization refusal: the caller must not
 * consume retry attempts for it. Every other non-OK answer stays unreadable and
 * therefore keeps its existing retry classification, so the deploy-ordering
 * window (a peer without this query answers 404) retries instead of failing.
 * Neither the token, the request body nor the peer's error body may appear in
 * the result message.
 *
 * Two properties are intended, and both were weighed against adding a retry
 * here.
 *
 * The read runs once per launch attempt. A transient answer is handed to the
 * caller's existing retry classification, which already owns the attempt budget
 * and its backoff; a retry inside this module would send a second request
 * within one attempt and keep that policy in two places.
 *
 * A `refused` answer stays permanent on the first answer. It describes a
 * credential the peer would not accept rather than a decision about the payer:
 * a policy denial arrives in-band as `insufficient_credits` with status 200,
 * and the peer has no denial answer in the authorization statuses at all.
 * Repeating the same request inside the same attempt cannot change that
 * credential, and the outcome is recorded with its own failure code instead of
 * spending the finding's remaining attempts.
 */
export async function readAnalysisCreditAdmission(params: {
  env: CloudflareEnv;
  authToken: string;
  organizationId?: string;
}): Promise<AnalysisCreditAdmission> {
  const input = JSON.stringify(
    params.organizationId ? { organizationId: params.organizationId } : {}
  );
  let response: Response;
  try {
    response = await params.env.CLOUD_AGENT_NEXT.fetch(
      new Request(
        `https://cloud-agent-next/trpc/getAnalysisCreditAdmission?input=${encodeURIComponent(input)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${params.authToken}` },
        }
      )
    );
  } catch {
    return { outcome: 'unavailable', message: 'Cloud Agent credit admission request failed' };
  }

  if (!response.ok) {
    // The status is never part of the message, and an authorization refusal is
    // the only non-OK answer that is decided here rather than left unreadable.
    logger.warn('Cloud Agent credit admission returned non-OK status', {
      status: response.status,
    });
    if (response.status === 401 || response.status === 403) {
      return { outcome: 'refused', message: 'Cloud Agent credit admission was refused' };
    }
    return {
      outcome: 'unavailable',
      message: 'Cloud Agent credit admission was not accepted',
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { outcome: 'unavailable', message: 'Cloud Agent credit admission body was not JSON' };
  }

  const parsed = CreditAdmissionResponseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      outcome: 'unavailable',
      message: 'Cloud Agent credit admission returned an unexpected response shape',
    };
  }

  return parsed.data.result.data;
}
