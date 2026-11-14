import { z } from 'zod';

export const AnalysisCreditAdmissionSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('admitted') }),
  z.object({ outcome: z.literal('insufficient_credits'), message: z.string() }),
  z.object({ outcome: z.literal('unavailable'), message: z.string() }),
]);

export type AnalysisCreditAdmission = z.infer<typeof AnalysisCreditAdmissionSchema>;

const CreditAdmissionResponseSchema = z.object({
  result: z.object({ data: AnalysisCreditAdmissionSchema }),
});

/**
 * Reads the Cloud Agent peer's analysis credit decision before this service
 * runs a triage model call and prepares a Cloud Agent session. The peer's
 * existing balance rule decides; nothing is re-derived here and the
 * initiate-time 402 stays authoritative.
 *
 * Any transport failure or unreadable response is `unavailable`, so the caller
 * keeps its normal retry and attempt classification. Neither the token, the
 * request body nor the peer's error body may appear in the result message.
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
    return {
      outcome: 'unavailable',
      message: `Cloud Agent credit admission returned HTTP ${response.status}`,
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
