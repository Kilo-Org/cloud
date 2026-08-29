import 'server-only';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ToolOutcome } from '@kilocode/agent-harness/contracts';
import { operation_ledgers } from '@kilocode/db/schema';
import { OPERATION_NON_TERMINAL_STATUSES } from '@kilocode/db/operation-ledger';
import { db } from '@/lib/drizzle';
import {
  basePrepareSessionNextSchema,
  baseSendMessageNextSchema,
} from '@/routers/cloud-agent-next-schemas';
import {
  createHarnessCloudAgentContext,
  normalizeCloudAgentAdmissionError,
} from './cloud-agent-context';

const Reference = z.object({
  kiloSessionId: z.string().startsWith('ses_').length(30),
  cloudAgentSessionId: z.string().min(1),
  initialMessageId: z.string(),
});

async function sessionOperation(
  token: string,
  input: unknown,
  reconcile: boolean
): Promise<ToolOutcome> {
  const context = createHarnessCloudAgentContext(token, input);
  const { invocation, request, messageId, fresh, owned, history } = context;
  const unknown: ToolOutcome = {
    status: 'outcome_unknown',
    reason: 'Check Cloud Agent status; do not repeat this operation.',
    providerReference: invocation.operationId,
  };
  const hasUserTurn = async (sessionId: string, content: string) =>
    (await history(sessionId)).some(
      message =>
        message.info.id === messageId &&
        message.info.role === 'user' &&
        message.parts
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n') === content
    );
  if (request.name === 'kilo.sessions.search') return context.search();
  if (request.name === 'kilo.sessions.attach') return context.attachContext();
  if (request.name === 'kilo.sessions.progress') return context.progress();
  let dispatched = false;
  try {
    const { caller, authority } = await fresh();
    const organizationId = authority.organizationId;
    switch (request.name) {
      case 'kilo.sessions.start': {
        if (reconcile) {
          const row = await db.query.operation_ledgers.findFirst({
            where: and(
              eq(operation_ledgers.kilo_user_id, authority.userId),
              eq(operation_ledgers.operation_key, invocation.operationId),
              eq(operation_ledgers.domain, 'session'),
              eq(operation_ledgers.intent, 'create_cloud')
            ),
          });
          if (!row) return unknown;
          if (row.organization_id !== organizationId) throw new TRPCError({ code: 'FORBIDDEN' });
          const reference = Reference.safeParse(row.canonical_result);
          if (!reference.success) return unknown;
          if (reference.data.initialMessageId !== messageId)
            throw new TRPCError({ code: 'CONFLICT' });
          const { session } = await owned(reference.data.kiloSessionId);
          if (session.cloud_agent_session_id !== reference.data.cloudAgentSessionId)
            throw new TRPCError({ code: 'FORBIDDEN' });
          // Allocation proves no admission. Failed settles cannot be overridden by history.
          if (
            row.status !== 'completed' &&
            (!OPERATION_NON_TERMINAL_STATUSES.some(status => status === row.status) ||
              !(await hasUserTurn(session.session_id, request.arguments.prompt)))
          )
            return unknown;
          return context.succeeded({ sessionId: session.session_id });
        }
        const prepared = basePrepareSessionNextSchema.parse({
          prompt: request.arguments.prompt,
          model: request.arguments.modelId,
          githubRepo: request.arguments.repository,
          mode: 'code',
          autoInitiate: true,
          operationKey: invocation.operationId,
          initialMessageId: messageId,
        });
        dispatched = true;
        // The existing grouped path persists both session IDs before initial admission.
        // Never call its retry ladder during reconciliation: its ledger has finite retention.
        const result =
          organizationId === null
            ? await caller.cloudAgentNext.prepareSession(prepared)
            : await caller.organizations.cloudAgentNext.prepareSession({
                ...prepared,
                organizationId,
              });
        return context.succeeded({ sessionId: result.kiloSessionId });
      }
      case 'kilo.sessions.continue':
      case 'kilo.sessions.stop': {
        const sessionId = request.arguments.sessionId;
        const current = await context.cloudSession(sessionId);
        const cloudAgentSessionId = current.cloudAgentSessionId;
        if (reconcile) {
          // Stop has no operation receipt. An idle/absent query cannot establish this Stop's outcome.
          if (
            request.name !== 'kilo.sessions.continue' ||
            !(await hasUserTurn(sessionId, request.arguments.message))
          )
            return unknown;
        } else if (request.name === 'kilo.sessions.stop') {
          const { caller } = await fresh();
          dispatched = true;
          const result =
            organizationId === null
              ? await caller.cloudAgentNext.interruptSession({ sessionId: cloudAgentSessionId })
              : await caller.organizations.cloudAgentNext.interruptSession({
                  sessionId: cloudAgentSessionId,
                  organizationId,
                });
          if (!result.success) return unknown;
        } else if (request.name === 'kilo.sessions.continue') {
          const state = await context.sessionState(current, cloudAgentSessionId);
          const message = baseSendMessageNextSchema.parse({
            cloudAgentSessionId,
            messageId,
            payload: {
              type: 'prompt',
              prompt: request.arguments.message,
              mode: state.mode,
              model: state.model,
              variant: state.variant,
            },
          });
          const { caller } = await fresh();
          dispatched = true;
          const result =
            organizationId === null
              ? await caller.cloudAgentNext.sendMessage(message)
              : await caller.organizations.cloudAgentNext.sendMessage({
                  ...message,
                  organizationId,
                });
          if (result.cloudAgentSessionId !== cloudAgentSessionId || result.messageId !== messageId)
            return unknown;
        }
        // The Kilo session ID is the shared app.openScreen session destination, not a stream ticket.
        return context.succeeded({ sessionId });
      }
    }
    throw new TRPCError({ code: 'BAD_REQUEST' });
  } catch (error) {
    // Preserve authoritative admission rejection without exposing provider text or transport causes.
    const rejection = normalizeCloudAgentAdmissionError(error);
    if (rejection) throw rejection;
    if (!dispatched && error instanceof TRPCError && error.code === 'CONFLICT') throw error;
    if (dispatched || reconcile) return unknown;
    throw error;
  }
}

// The durable scheduler dispatches an admitted call once and retains its canonical result.
// On response loss it must use reconciliation, never execute again, including after ledger expiry.
export const executeHarnessCloudAgent = (token: string, input: unknown) =>
  sessionOperation(token, input, false);
export const reconcileHarnessCloudAgent = (token: string, input: unknown) =>
  sessionOperation(token, input, true);
