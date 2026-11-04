import type { EnvironmentSetupNetworkRequest } from '@kilocode/cloud-agent-profile';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';

export type NetworkRequestDecision = 'approve' | 'decline';

export function pendingNetworkRequests(
  requests: readonly EnvironmentSetupNetworkRequest[]
): EnvironmentSetupNetworkRequest[] {
  return requests.filter(request => request.state === 'pending');
}

export function networkDecisionLists(
  decisions: Readonly<Record<string, NetworkRequestDecision>>,
  hosts: readonly string[]
): { approved: string[]; declined: string[] } {
  const approved: string[] = [];
  const declined: string[] = [];
  for (const host of hosts) {
    const decision = decisions[host];
    if (decision === 'approve') {
      approved.push(host);
    } else if (decision === 'decline') {
      declined.push(host);
    }
  }
  return { approved, declined };
}

export function allHostsDecided(
  decisions: Readonly<Record<string, NetworkRequestDecision>>,
  hosts: readonly string[]
): boolean {
  return hosts.every(host => decisions[host] === 'approve' || decisions[host] === 'decline');
}

export function childKiloSessionIdFor(
  run: Pick<SetupRunResponse, 'lastVerification' | 'pendingVerification'>,
  childSessionId: string
): string | null {
  if (run.lastVerification?.childSessionId === childSessionId) {
    return run.lastVerification.childKiloSessionId;
  }
  if (run.pendingVerification?.childSessionId === childSessionId) {
    return run.pendingVerification.childKiloSessionId;
  }
  return null;
}
