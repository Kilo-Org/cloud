import 'server-only';
import { z } from 'zod';
import { timingSafeEqual } from '@kilocode/encryption';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { boundedBody, mediaType, streamHarnessModel } from './model-stream';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { APP_URL, ORGANIZATION_ID_HEADER } from '@/lib/constants';
import { FEATURE_HEADER } from '@/lib/feature-detection';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { authorizeHarnessCapability, harnessInputDigest } from './authorization';
import { Id, messages } from './operation-contract';

// Keep the SDK's chat-completions wire data; validate only the inference boundary here.
const Input = z.strictObject({
  conversationId: Id,
  runId: Id,
  operationId: Id,
  completion: z.looseObject({
    model: z.string().trim().min(1),
    messages: z.array(z.json()).min(1),
    stream: z.literal(true),
    max_tokens: z.int().positive().max(8192),
    max_completion_tokens: z.never().optional(),
    n: z.literal(1).optional(),
    tools: z.array(z.looseObject({ type: z.literal('function') })).optional(),
    plugins: z.never().optional(),
  }),
});
export function harnessModelScope(raw: unknown) {
  const input = Input.parse(raw);
  return {
    audience: 'agent-harness:model',
    conversationId: input.conversationId,
    operation: 'model',
    definitionVersion: '1',
    inputDigest: harnessInputDigest(input),
    dispatchId: input.operationId,
    target: { kind: 'backend' as const },
  };
}
function failure(status: number) {
  const type =
    status === 401 || status === 403
      ? 'access_revoked'
      : status === 402 || status === 413
        ? 'limit_exceeded'
        : status === 499
          ? 'cancelled'
          : status === 422
            ? 'invalid_output'
            : status === 408 || status === 429 || status >= 500
              ? 'storage_unavailable'
              : 'invalid_input';
  return {
    error: {
      code: status,
      type,
      message: messages[type],
      retryable: type === 'storage_unavailable',
    },
  };
}

export async function proxyHarnessModel(request: Request) {
  const headers = new Headers({ 'cache-control': 'no-store', 'content-type': 'application/json' });
  const reply = (status: number) => Response.json(failure(status), { status, headers });
  const service = request.headers.get('x-internal-api-key');
  const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!INTERNAL_API_SECRET || !service || !timingSafeEqual(service, INTERNAL_API_SECRET) || !token)
    return reply(401);
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(90_000)]);
  const errorStatus = (error: unknown, invalid: number) => {
    if (request.signal.aborted) return 499;
    if (error instanceof TRPCError)
      return error.code === 'UNAUTHORIZED' ? 403 : getHTTPStatusCodeFromError(error);
    // Native decoding errors retain their code across JavaScript realms.
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA')
    )
      return invalid;
    // Other request-body TypeErrors reject input; upstream transport errors remain retryable.
    return invalid === 400 && error instanceof TypeError ? 400 : 503;
  };
  let input: z.infer<typeof Input>;
  try {
    if (mediaType(request.headers) !== 'application/json' || !request.body) return reply(400);
    const bytes = await new Response(boundedBody(request.body, signal)).arrayBuffer();
    input = Input.parse({
      conversationId: request.headers.get('x-agent-harness-conversation-id'),
      runId: request.headers.get('x-agent-harness-run-id'),
      operationId: request.headers.get('x-agent-harness-operation-id'),
      completion: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    });
  } catch (error) {
    return reply(errorStatus(error, 400));
  }
  try {
    const { authority, ctx } = await authorizeHarnessCapability(token, harnessModelScope(input));
    signal.throwIfAborted();
    const upstreamHeaders = new Headers({
      authorization: `Bearer ${generateApiToken(ctx.user, { tokenSource: 'agent-harness' }, { expiresIn: TOKEN_EXPIRY.fiveMinutes })}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      [FEATURE_HEADER]: 'quick-chat',
      'x-kilo-request': input.operationId,
      'x-kilocode-taskid': input.runId,
      'x-kilo-session': input.conversationId,
    });
    if (authority.organizationId)
      upstreamHeaders.set(ORGANIZATION_ID_HEADER, authority.organizationId);
    // The billed gateway owns availability, organization policy, BYOK/free exceptions, and charges.
    const response = await fetch(`${APP_URL}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(input.completion),
      signal,
      redirect: 'error',
    });
    return await streamHarnessModel(response, headers, { signal, abort, failure, errorStatus });
  } catch (error) {
    abort.abort();
    return reply(errorStatus(error, 422));
  }
}
