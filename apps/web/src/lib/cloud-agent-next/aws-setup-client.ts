import 'server-only';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { AWS_SETUP_ERRORS, type AwsSetupErrorCode } from '@kilocode/worker-utils/aws-onboarding';
import type { AwsSetupRequest } from '@kilocode/worker-utils/aws-onboarding-api';

function knownError(code: string): code is AwsSetupErrorCode {
  return Object.hasOwn(AWS_SETUP_ERRORS, code);
}

/** Call only with ownership from auth context and ciphertext loaded from that owner's row. */
export async function awsSetupRequest<T>(input: AwsSetupRequest, schema: z.ZodType<T>): Promise<T> {
  try {
    const base = getEnvVariable('CLOUD_AGENT_NEXT_API_URL');
    if (!base || !INTERNAL_API_SECRET) throw new Error('AWS setup service unavailable');
    const response = await fetch(`${base}/internal/byoc/aws/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-api-key': INTERNAL_API_SECRET },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(55_000),
      cache: 'no-store',
    });
    if (!response.body) throw new Error('AWS setup response is empty');
    const result = await readBoundedStream(response.body, 128 * 1024);
    if (!result.ok) throw new Error('AWS setup response is too large');
    const body: unknown = JSON.parse(new TextDecoder().decode(result.bytes));
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(body);
      if (error.success && knownError(error.data.error)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: AWS_SETUP_ERRORS[error.data.error],
        });
      }
      throw new Error('AWS setup request failed');
    }
    return schema.parse(body);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: AWS_SETUP_ERRORS.byoc_aws_setup_unavailable,
    });
  }
}
