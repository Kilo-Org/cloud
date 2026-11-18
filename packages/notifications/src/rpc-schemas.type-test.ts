import type { InternalDispatchSecurityLifecycleRequest } from './rpc-schemas';

const securityLifecycleRequest = {
  kind: 'security_lifecycle',
  event: 'remediation_pr_opened',
  findingId: 'finding-1',
  scope: 'org-1',
  remediationId: 'remediation-1',
  prUrl: 'https://github.com/acme/api/pull/42',
  recipientUserIds: ['user-a', 'user-b'],
} satisfies InternalDispatchSecurityLifecycleRequest;

void securityLifecycleRequest;
