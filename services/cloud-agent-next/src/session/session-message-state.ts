import { z } from 'zod';
import {
  type CloudAgentFailureCode,
  type CloudAgentFailureStage,
} from '@kilocode/worker-utils/cloud-agent-failure';
import type { CloudAgentRunStateReport } from '@kilocode/worker-utils/cloud-agent-queue-report';

export const SessionMessageCompletionSourceSchema = z.enum([
  'assistant_message_event',
  'manual_compact_summarize',
  'idle_reconciliation',
  'wrapper_failure',
  'interrupt',
  'delivery_failure',
  'canceled',
]);
export type SessionMessageCompletionSource = z.infer<typeof SessionMessageCompletionSourceSchema>;

type AssertTrue<T extends true> = T;
type CloudAgentRunFailureStage = NonNullable<CloudAgentRunStateReport['run']['failureStage']>;
type CloudAgentRunFailureCode = NonNullable<CloudAgentRunStateReport['run']['failureCode']>;
type StageContractMatchesReport = AssertTrue<
  CloudAgentRunFailureStage extends CloudAgentFailureStage ? true : false
>;
type CodeContractMatchesReport = AssertTrue<
  CloudAgentRunFailureCode extends CloudAgentFailureCode ? true : false
>;
export type SessionMessageFailureStage = StageContractMatchesReport extends true
  ? CloudAgentFailureStage
  : never;
export type SessionMessageFailureCode = CodeContractMatchesReport extends true
  ? CloudAgentFailureCode
  : never;
