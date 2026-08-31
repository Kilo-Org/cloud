import 'server-only';
import { z } from 'zod';
import { ErrorSchema } from '@kilocode/agent-harness/contracts';
import { toolDefinitions } from '@kilocode/agent-harness/tools';
import {
  authorizeHarnessCapability,
  harnessInputDigest,
  mintHarnessCapability,
} from './authorization';
import { authorizeHarnessMcp } from './mcp';
import { executeHarnessWeb } from './web-tools';
import {
  HarnessOperationSchema,
  bounded,
  harnessOperationFailure,
  harnessOperationScope,
  invalid,
  safeError,
} from './operation-contract';

export async function executeHarnessProviders(raw: unknown, token: string, signal: AbortSignal) {
  let dispatchSignal = signal;
  try {
    const parsed = HarnessOperationSchema.safeParse(raw);
    if (!parsed.success) return invalid();
    const input = parsed.data;
    if (input.type !== 'execute' && input.type !== 'reconcile') return invalid();
    const scope = harnessOperationScope(bounded(input));
    const { grant } = await authorizeHarnessCapability(token, scope);
    const { request, dispatchStartedAt, reservation } = input;
    const definition = toolDefinitions.find(tool => tool.name === request.name);
    if (
      !definition ||
      definition.executorKind !== 'backend' ||
      (definition.group !== 'mcp' && definition.group !== 'web') ||
      input.type === 'reconcile'
    )
      return invalid();
    const web = request.name === 'web.search' || request.name === 'web.retrieve';
    if (
      web &&
      (!reservation ||
        reservation.id !== input.operationId ||
        reservation.runId !== input.runId ||
        reservation.toolCallId !== input.toolCallId ||
        reservation.startedAt !== dispatchStartedAt ||
        reservation.startedAt > Date.now() ||
        reservation.deadline <= Date.now() ||
        reservation.deadline - reservation.startedAt > 30_000)
    )
      invalid();
    // Verify the full envelope above before minting the adapter's narrower capability.
    const capability = await mintHarnessCapability(grant.id, {
      ...scope,
      operation: request.name,
      definitionVersion: definition.version,
      inputDigest: harnessInputDigest(request.arguments),
    });
    signal.throwIfAborted();
    const invocation = { conversationId: input.conversationId, operationId: input.operationId };
    if (request.name === 'mcp.discover' || request.name === 'mcp.call') {
      // Derived gateway authorization is server-to-server only, never a tool result or model message.
      return {
        result: bounded(
          z
            .array(
              z.object({
                serverId: z.string().min(1),
                configurationVersion: z.string().min(1),
                url: z.url({ protocol: /^https$/ }).refine(value => {
                  const url = new URL(value);
                  return !url.username && !url.password;
                }),
                authorization: z.string().startsWith('Bearer ').min(8).max(8192),
              })
            )
            .parse(await authorizeHarnessMcp(capability, { ...invocation, request }))
        ),
      };
    }
    if (web && reservation) {
      // Minting rechecks primary authority asynchronously; the original deadline must still be live.
      const remaining = reservation.deadline - Date.now();
      if (remaining <= 0) return invalid();
      dispatchSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      const reply = z
        .discriminatedUnion('status', [
          z.strictObject({
            status: z.literal('succeeded'),
            body: z.json(),
            costMicrodollars: z.int().nonnegative().nullable(),
          }),
          z.strictObject({
            status: z.literal('failed'),
            error: ErrorSchema,
            costMicrodollars: z.int().nonnegative().nullable(),
          }),
        ])
        .parse(
          await executeHarnessWeb(
            capability,
            { ...invocation, request },
            1024 * 1024,
            dispatchSignal
          )
        );
      try {
        return {
          result: bounded(
            reply.status === 'failed' ? { ...reply, error: safeError(reply.error) } : reply,
            1024 * 1024
          ),
        };
      } catch (error) {
        return {
          result: {
            status: 'failed' as const,
            ...harnessOperationFailure(error),
            costMicrodollars: reply.costMicrodollars,
          },
        };
      }
    }
    return invalid();
  } catch (error) {
    return dispatchSignal.aborted
      ? { error: safeError({ code: 'cancelled', message: '', retryable: false }) }
      : harnessOperationFailure(error);
  }
}
