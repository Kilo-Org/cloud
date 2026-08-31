import { timingSafeEqual } from '@kilocode/encryption';
import { TRPCError } from '@trpc/server';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { executeHarnessOperation, harnessOperationFailure } from '@/lib/agent-harness/operations';

export const maxDuration = 60;

export async function POST(request: Request) {
  const reply = (body: Awaited<ReturnType<typeof executeHarnessOperation>>, status = 200) => {
    let json = JSON.stringify(body);
    if (Buffer.byteLength(json, 'utf8') > 1024 * 1024) {
      const failure = harnessOperationFailure(new TRPCError({ code: 'PAYLOAD_TOO_LARGE' }));
      const result = 'result' in body ? body.result : undefined;
      if (result && typeof result === 'object' && 'costMicrodollars' in result) {
        // Keep the validated actual cost, even when cancellation races with the completed reply.
        body = {
          result: { status: 'failed', ...failure, costMicrodollars: result.costMicrodollars },
        };
      } else {
        body = failure;
        status = 400;
      }
      json = JSON.stringify(body);
    }
    return new Response(json, {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  };
  const service = request.headers.get('x-internal-api-key');
  if (!INTERNAL_API_SECRET || !service || !timingSafeEqual(service, INTERNAL_API_SECRET))
    return reply(harnessOperationFailure(new TRPCError({ code: 'UNAUTHORIZED' })), 401);
  const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token) return reply(harnessOperationFailure(new TRPCError({ code: 'UNAUTHORIZED' })), 401);
  let input: unknown;
  const reader = request.body?.getReader();
  try {
    if (
      request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
        'application/json' ||
      !reader
    )
      throw new TRPCError({ code: 'BAD_REQUEST' });
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE' });
      chunks.push(value);
    }
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    return reply(
      harnessOperationFailure(
        error instanceof TRPCError ? error : new TRPCError({ code: 'BAD_REQUEST' })
      ),
      400
    );
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
  const result = await executeHarnessOperation(token, input, request.signal);
  return reply(
    result,
    'error' in result
      ? result.error.code === 'access_revoked'
        ? 403
        : result.error.retryable
          ? 503
          : 400
      : 200
  );
}
