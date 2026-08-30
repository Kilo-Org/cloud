import 'server-only';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { ErrorSchema } from '@kilocode/agent-harness/contracts';
import { ToolRequestSchema, toolDefinitions } from '@kilocode/agent-harness/tools';
import { validatePublicHttpsDestination } from '@/lib/mcp-gateway/discovery-service';
import { extractExaCostMicrodollars, prepareExaRequest } from '@/lib/exa-provider';
import { authorizeHarnessCapability, harnessInputDigest } from './authorization';

const Invocation = z.strictObject({
  conversationId: z.uuid(),
  operationId: z.uuid(),
  request: ToolRequestSchema,
});

/** Internal adapter only. The Worker commits its web request reservation before calling this boundary. */
export async function executeHarnessWeb(
  token: string,
  input: unknown,
  httpResponseBytes: number,
  signal: AbortSignal
) {
  let costMicrodollars: number | null = 0;
  const failed = (
    code: z.infer<typeof ErrorSchema>['code'],
    message: string,
    retryable = false
  ) => ({ status: 'failed' as const, error: { code, message, retryable }, costMicrodollars });
  try {
    const parsed = Invocation.safeParse(input);
    if (
      !parsed.success ||
      !Number.isSafeInteger(httpResponseBytes) ||
      httpResponseBytes < 1 ||
      httpResponseBytes > 1024 * 1024
    )
      return failed('invalid_input', 'Invalid web request.');
    const { conversationId, operationId, request } = parsed.data;
    if (request.name !== 'web.search' && request.name !== 'web.retrieve')
      return failed('invalid_input', 'Invalid web request.');
    const definition = toolDefinitions.find(tool => tool.name === request.name);
    if (!definition) return failed('invalid_input', 'Invalid web request.');
    const { authority, ctx } = await authorizeHarnessCapability(token, {
      audience: 'agent-harness:operations',
      conversationId,
      operation: request.name,
      definitionVersion: definition.version,
      inputDigest: harnessInputDigest(request.arguments),
      dispatchId: operationId,
      target: { kind: 'backend' },
    });
    let target: string | undefined;
    if (request.name === 'web.retrieve') {
      try {
        target = (await validatePublicHttpsDestination(request.arguments.url)).href;
      } catch {
        return failed('invalid_input', 'The page URL must resolve to a public HTTPS destination.');
      }
    }
    const provider = await prepareExaRequest(ctx.user, authority.organizationId ?? undefined);
    if (provider instanceof Response)
      return failed(
        provider.status === 402 ? 'limit_exceeded' : 'unavailable_tool',
        provider.status === 402
          ? 'Exa allowance and credit balance are exhausted.'
          : 'Web search is unavailable.'
      );
    signal.throwIfAborted();
    const path = request.name === 'web.search' ? '/search' : '/contents';
    const body =
      request.name === 'web.search'
        ? {
            query: request.arguments.query,
            numResults: request.arguments.limit,
            contents: { text: true },
          }
        : { ids: [target], text: true };
    // No trusted pre-call Exa price exists. A lost response leaves actual cost unknown.
    costMicrodollars = null;
    const response = await provider.send(path, body, signal, true);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return failed(
        'unavailable_tool',
        'The web provider rejected the request.',
        response.status >= 500 || response.status === 408 || response.status === 429
      );
    }
    if (
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
        'application/json' ||
      !response.body
    ) {
      await response.body?.cancel().catch(() => undefined);
      return failed('invalid_output', 'The web provider returned unsupported content.');
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let text = '',
      size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > httpResponseBytes)
          return failed('limit_exceeded', 'The web response is too large.');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const result: unknown = JSON.parse(text);
    try {
      costMicrodollars = extractExaCostMicrodollars(result) ?? null;
    } catch {
      return failed('invalid_output', 'The web provider returned an invalid cost.');
    }
    await provider.record(path, costMicrodollars ?? undefined, 'quick-chat');
    return { status: 'succeeded' as const, body: result, costMicrodollars };
  } catch (error) {
    if (signal.aborted) return failed('cancelled', 'The web request was cancelled.');
    if (error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code))
      return failed('access_revoked', 'Access to this conversation is unavailable.');
    if (error instanceof SyntaxError)
      return failed('invalid_output', 'The web provider returned invalid JSON.');
    return failed(
      'unavailable_tool',
      'The web request failed. Retry within the remaining request budget.',
      true
    );
  }
}
