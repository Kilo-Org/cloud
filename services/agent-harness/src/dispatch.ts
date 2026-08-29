import { toolModelMessageSchema } from 'ai';
import { eq } from 'drizzle-orm';
import type { ToolCall, ToolOutcome } from '@kilocode/agent-harness/contracts';
import { evaluateDispatch, type DispatchPolicy } from '@kilocode/agent-harness/policy';
import { compareAndSetCall, insertAttempt, type StoreDatabase } from './db/records';
import type { ConversationStore } from './db/store';
import * as s from './db/sqlite-schema';
import { StoreError } from './db/wake';
import { CompleteStepSchema, jsonValue } from './model-step';
import { fail } from './limits';

// Only the scheduler calls this inside its prearmed synchronous transition.
export function commitDispatch(
  db: StoreDatabase,
  stored: ReturnType<ConversationStore['callsForRun']>[number],
  proposed: ToolCall,
  policy: DispatchPolicy,
  attemptId: string,
  generation: number
) {
  const decision = evaluateDispatch(stored.data, proposed, policy);
  db.update(s.calls)
    .set({ policy: { ...policy, decision } })
    .where(eq(s.calls.id, stored.id))
    .run();
  if (decision === 'dispatch') {
    insertAttempt(db, { id: attemptId, toolCallId: stored.id, generation });
    if (
      !compareAndSetCall(db, stored.id, stored.revision, {
        state: 'executing',
        approval: stored.data.approval,
        result: null,
      })
    )
      throw new StoreError('command_conflict');
  }
  return decision;
}

export function toolResultMessage(db: StoreDatabase, call: ToolCall, outcome: ToolOutcome) {
  const row = db.select().from(s.calls).where(eq(s.calls.id, call.id)).get();
  const checkpoint =
    row && db.select().from(s.checkpoints).where(eq(s.checkpoints.id, row.checkpointId)).get();
  const item = CompleteStepSchema.parse(checkpoint?.data).calls.find(
    item => item.call.id === call.id
  );
  if (!item) fail('invalid_output', 'The outcome has no matching SDK call.');
  return toolModelMessageSchema.parse({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: item.sdkId,
        toolName: call.name,
        output: {
          type: outcome.status === 'succeeded' ? 'json' : 'error-json',
          value: jsonValue(outcome.status === 'succeeded' ? outcome.output : outcome),
        },
      },
    ],
  });
}
