import 'server-only';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import {
  createQuickChatRuntime,
  QuickChatAuthorityError,
  QuickChatAuthoritySchema,
} from '@kilocode/db/quick-chat-runtime';
import { agent_harness_retirements } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { INTERNAL_API_SECRET, NEXTAUTH_SECRET } from '@/lib/config.server';
import {
  Id,
  Time,
  bounded,
  harnessOperationScope,
  invalid,
  type HarnessOperation,
} from './operation-contract';
import { authorizeHarnessCapability } from './authorization';
import { drainLegacyHistoryWithProgress } from './history';
import { sendHarnessMaintenance } from './retirement';

export async function retirement(
  input: Extract<HarnessOperation, { type: 'retirement' }>,
  token: string
) {
  // A deleted account has no grant. Only the exact signed purge request can check its primary fence.
  const request = {
    type: 'purge',
    protocolVersion: 1,
    threadId: input.conversationId,
    generation: input.generation,
  };
  try {
    const claims = z
      .strictObject({
        iss: z.literal('agent-harness'),
        aud: z.literal('agent-harness:maintenance'),
        operation: z.literal('purge'),
        threadId: z.literal(input.conversationId),
        generation: z.literal(input.generation),
        dispatchId: z.literal(input.operationId),
        inputDigest: z.literal(createHash('sha256').update(JSON.stringify(request)).digest('hex')),
        iat: Time,
        exp: Time,
      })
      .parse(
        jwt.verify(token, NEXTAUTH_SECRET, {
          algorithms: ['HS256'],
          issuer: 'agent-harness',
          audience: 'agent-harness:maintenance',
          maxAge: 60,
        })
      );
    if (
      claims.iat > Math.floor(Date.now() / 1000) ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 60
    )
      throw new Error('Invalid maintenance lifetime');
  } catch {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
  const fence = await db.query.agent_harness_retirements.findFirst({
    columns: { thread_id: true, generation: true },
    where: and(
      eq(agent_harness_retirements.thread_id, input.conversationId),
      eq(agent_harness_retirements.generation, input.generation)
    ),
  });
  if (!fence || fence.thread_id !== input.conversationId || fence.generation !== input.generation)
    throw new TRPCError({ code: 'FORBIDDEN' });
  return { retired: true };
}

export async function executeHarnessMaintenance(
  input: Extract<HarnessOperation, { type: 'read' | 'history' | 'projection' }>,
  token: string
) {
  try {
    const { authority } = await authorizeHarnessCapability(
      token,
      harnessOperationScope(bounded(input))
    );
    const source = createQuickChatRuntime(db);
    switch (input.type) {
      case 'read':
        return { result: bounded(QuickChatAuthoritySchema.strict().parse(authority)) };
      case 'history': {
        const progress = await drainLegacyHistoryWithProgress(
          source,
          work =>
            sendHarnessMaintenance(
              process.env.AGENT_HARNESS_API_URL,
              NEXTAUTH_SECRET,
              INTERNAL_API_SECRET,
              { type: 'importLegacy', protocolVersion: 1, ...work },
              work.message.id
            ),
          { authority, limit: input.limit }
        );
        return {
          result: bounded(
            z
              .strictObject({
                deliveries: z
                  .array(
                    z.strictObject({
                      id: Id,
                      status: z.enum(['acknowledged', 'retry', 'rejected']),
                    })
                  )
                  .max(input.limit),
                backlog: z.enum(['pending', 'drained']),
              })
              .parse(progress)
          ),
        };
      }
      case 'projection': {
        if (input.projection.key !== `agent-harness:${input.conversationId}:${input.projection.id}`)
          invalid();
        return {
          result: Id.pipe(z.literal(input.projection.id)).parse(
            await source.projectText(authority, input.projection)
          ),
        };
      }
    }
  } catch (error) {
    if (error instanceof QuickChatAuthorityError) throw new TRPCError({ code: 'FORBIDDEN' });
    throw error;
  }
}
