import type {
  ScheduledActionEvent,
  SendScheduledActionNoticeParams,
  SendScheduledActionNoticeResult,
  SendSessionAttentionNotificationParams,
  SendSessionAttentionNotificationResult,
  SessionAttentionReason,
} from './rpc-schemas';

const scheduledActionEvent = 'scheduled_restart_notice' satisfies ScheduledActionEvent;

const scheduledActionParams = {
  userId: 'user-1',
  instanceId: 'sandbox-1',
  sandboxId: 'sandbox-1',
  event: scheduledActionEvent,
  instanceName: 'Bot',
  scheduledAt: '2026-05-05T12:00:00.000Z',
  targetImageTag: null,
} satisfies SendScheduledActionNoticeParams;

const scheduledActionResult = {
  tokenCount: 1,
  sent: 1,
  staleTokens: 0,
  receiptCount: 1,
} satisfies SendScheduledActionNoticeResult;

void scheduledActionParams;
void scheduledActionResult;

const attentionReasons = [
  'question',
  'permission',
  'blocking_suggestion',
  'action_required',
] as const satisfies readonly SessionAttentionReason[];

const attentionParams = {
  userId: 'user-1',
  cliSessionId: 'ses_1',
  requestId: 'req_1',
  reason: 'question',
} satisfies SendSessionAttentionNotificationParams;

const attentionResult = {
  dispatched: true,
} satisfies SendSessionAttentionNotificationResult;

void attentionReasons;
void attentionParams;
void attentionResult;
