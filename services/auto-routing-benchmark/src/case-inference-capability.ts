import {
  BENCHMARK_CASE_CAPABILITY_SCOPE,
  BenchmarkCaseInvocationSchema,
  benchmarkCaseCapabilityParts,
  type BenchmarkCaseInvocation,
} from '@kilocode/auto-routing-contracts';
import { base64urlToBytes, bytesToBase64url } from '@kilocode/worker-utils/base64url';
import { deriveCallbackToken, verifyCallbackToken } from '@kilocode/worker-utils/callback-token';

export const BENCHMARK_CASE_HEADER = 'x-kilo-benchmark-case';
export const BENCHMARK_CASE_CAPABILITY_TTL_MS = 15 * 60_000;
const MAX_ENCODED_INVOCATION_LENGTH = 4096;
const WORKER_CLOCK_SKEW_MS = 5_000;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export async function issueCaseInferenceCapability(
  secret: string,
  invocation: BenchmarkCaseInvocation
): Promise<{ authorization: string; invocationHeader: string }> {
  const token = await deriveCallbackToken({
    secret,
    scope: BENCHMARK_CASE_CAPABILITY_SCOPE,
    resourceParts: benchmarkCaseCapabilityParts(invocation),
  });
  return {
    authorization: `Bearer ${token}`,
    invocationHeader: bytesToBase64url(new TextEncoder().encode(JSON.stringify(invocation))),
  };
}

export async function verifyCaseInferenceCapability(
  secret: string,
  headers: Headers,
  now = Date.now()
): Promise<BenchmarkCaseInvocation | null> {
  const encoded = headers.get(BENCHMARK_CASE_HEADER);
  const authorization = headers.get('authorization');
  if (
    !encoded ||
    encoded.length > MAX_ENCODED_INVOCATION_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    !authorization?.startsWith('Bearer ')
  )
    return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(utf8.decode(base64urlToBytes(encoded)));
  } catch {
    return null;
  }
  const invocation = BenchmarkCaseInvocationSchema.safeParse(decoded);
  if (!invocation.success) return null;
  if (
    invocation.data.startedAt > now + WORKER_CLOCK_SKEW_MS ||
    now - invocation.data.startedAt >= BENCHMARK_CASE_CAPABILITY_TTL_MS
  )
    return null;

  const authenticated = await verifyCallbackToken({
    secret,
    token: authorization.slice('Bearer '.length),
    scope: BENCHMARK_CASE_CAPABILITY_SCOPE,
    resourceParts: benchmarkCaseCapabilityParts(invocation.data),
    observation: { receiver: 'auto-routing-benchmark', caller: headers.get('x-kilo-caller') },
  });
  return authenticated ? invocation.data : null;
}
