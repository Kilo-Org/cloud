import type {
  InternalDispatchSecurityLifecycleRequest,
  ScheduledActionEvent,
  SendScheduledActionNoticeParams,
  SendScheduledActionNoticeResult,
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

const securityLifecycleRequest = {
  kind: 'security_lifecycle',
  event: 'remediation_pr_opened',
  findingId: 'finding-1',
  scope: 'org-1',
  remediationId: 'remediation-1',
  prUrl: 'https://github.com/acme/api/pull/42',
  recipientUserIds: ['user-a', 'user-b'],
} satisfies InternalDispatchSecurityLifecycleRequest;

void scheduledActionParams;
void scheduledActionResult;
void securityLifecycleRequest;
