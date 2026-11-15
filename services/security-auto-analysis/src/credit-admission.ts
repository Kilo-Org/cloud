import { z } from 'zod';
import { logger } from './logger.js';

const PeerAnalysisCreditAdmissionSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('admitted') }),
  z.object({ outcome: z.literal('insufficient_credits'), message: z.string() }),
  z.object({ outcome: z.literal('unavailable'), message: z.string() }),
]);

/**
 * The peer's three answers plus `refused`, which this service produces itself
 * from a 403 answer so the caller gets a typed outcome instead of matching
 * message text.
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
 * Bound on the credit admission read. The launch holds the analysis claim while
 * it runs, so a peer that accepts the request and never answers must not hold
 * that claim: the request carries its own deadline, and an aborted read reports
 * the same unreadable outcome as any other unanswered read, which keeps it
 * retryable.
 */
export const ADMISSION_READ_TIMEOUT_MS = 10_000;

/**
 * Reads the Cloud Agent peer's analysis credit decision before this service
 * runs a triage model call and prepares a Cloud Agent session. The peer's
 * existing balance rule decides; nothing is re-derived here and the
 * initiate-time 402 stays authoritative.
 *
 * A 403 answer is a refusal of the token's authority scope for this
 * organization, and it is decided: the caller must not consume retry attempts
 * for it. A 401 stays unreadable like every other non-OK answer, because the
 * peer's credential verdict can reflect a verification state that a deployment
 * changes (secret version skew, token flags) rather than a decision about the
 * finding, and a single such answer must not settle it. Unreadable answers keep
 * their existing retry classification, so the deploy-ordering window (a peer
 * without this query answers 404) retries instead of failing.
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
 * Nothing else here decides a payer. The peer's payer decision arrives in-band
 * as `insufficient_credits` on a 200, and a dependency failure throws at the
 * peer and arrives as 503, so it is already unreadable and keeps its retry
 * classification.
 *
 * `timeoutMs` exists for tests, which need a short bound to observe the
 * deadline; callers use the default.
 */
export async function readAnalysisCreditAdmission(params: {
  env: CloudflareEnv;
  authToken: string;
  organizationId?: string;
  timeoutMs?: number;
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
          signal: AbortSignal.timeout(params.timeoutMs ?? ADMISSION_READ_TIMEOUT_MS),
        }
      )
    );
  } catch {
    return { outcome: 'unavailable', message: 'Cloud Agent credit admission request failed' };
  }

  if (!response.ok) {
    // The status is never part of the message. A 403 refuses the token's
    // authority scope and is decided here; a 401 is left unreadable because the
    // peer's credential verdict can change with its deployment.
    logger.warn('Cloud Agent credit admission returned non-OK status', {
      status: response.status,
    });
    if (response.status === 403) {
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
