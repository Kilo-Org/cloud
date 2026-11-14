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
