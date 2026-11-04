'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useEnvironmentSetupRunMutations } from '@/hooks/useEnvironmentSetupRuns';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';
import { buildCloudChatSessionPath } from './cloud-session-fork';
import {
  allHostsDecided,
  childKiloSessionIdFor,
  networkDecisionLists,
  pendingNetworkRequests,
  type NetworkRequestDecision,
} from './network-requests';

type NetworkRequestsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId?: string;
  run: SetupRunResponse;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The decisions could not be saved.';
}

export function NetworkRequestsDialog({
  open,
  onOpenChange,
  organizationId,
  run,
}: NetworkRequestsDialogProps) {
  const idPrefix = useId();
  const [decisions, setDecisions] = useState<Record<string, NetworkRequestDecision>>({});
  const [error, setError] = useState<string | null>(null);
  const { resolveNetworkRequests } = useEnvironmentSetupRunMutations();

  const requests = pendingNetworkRequests(run.networkRequests);
  const hosts = requests.map(request => request.host);
  const decided = allHostsDecided(decisions, hosts);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setDecisions({});
      setError(null);
    }
    onOpenChange(next);
  };

  const handleSave = async () => {
    setError(null);
    const { approved, declined } = networkDecisionLists(decisions, hosts);
    try {
      await resolveNetworkRequests.mutateAsync({
        organizationId,
        runId: run.id,
        approved,
        declined,
      });
      onOpenChange(false);
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>Network requests</DialogTitle>
          <DialogDescription>
            Approved hosts are added to this environment&apos;s required hosts. Sessions with None
            or Limited network access can reach them.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {requests.length === 0 ? (
            <p className="text-muted-foreground text-sm">No hosts are waiting for a decision.</p>
          ) : (
            requests.map((request, index) => {
              const decision = decisions[request.host];
              const childKiloSessionId = childKiloSessionIdFor(
                run,
                request.evidence.childSessionId
              );
              const deniedCount = request.evidence.deniedCount;
              const approveId = `${idPrefix}-${index}-approve`;
              const declineId = `${idPrefix}-${index}-decline`;

              return (
                <div
                  key={request.host}
                  className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0"
                >
                  <p className="font-mono text-sm break-all">{request.host}</p>
                  <p className="text-sm">
                    <span className="text-muted-foreground">Reason given by the agent: </span>
                    {request.reason}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Denied {deniedCount} {deniedCount === 1 ? 'time' : 'times'} in a test session
                    {childKiloSessionId !== null && (
                      <>
                        {' · '}
                        <Link
                          href={buildCloudChatSessionPath(organizationId, childKiloSessionId)}
                          className="text-link underline underline-offset-4"
                        >
                          Open test chat
                        </Link>
                      </>
                    )}
                  </p>
                  <RadioGroup
                    value={decision ?? ''}
                    onValueChange={value => {
                      if (value !== 'approve' && value !== 'decline') return;
                      setDecisions(previous => ({ ...previous, [request.host]: value }));
                    }}
                    className="flex gap-4"
                    aria-label={`Decision for ${request.host}`}
                  >
                    <div className="flex items-center gap-2 pointer-coarse:min-h-11">
                      <RadioGroupItem value="approve" id={approveId} />
                      <Label htmlFor={approveId}>Approve</Label>
                    </div>
                    <div className="flex items-center gap-2 pointer-coarse:min-h-11">
                      <RadioGroupItem value="decline" id={declineId} />
                      <Label htmlFor={declineId}>Decline</Label>
                    </div>
                  </RadioGroup>
                </div>
              );
            })
          )}

          {error !== null && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t px-6 py-4">
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="sm"
                className="pointer-coarse:min-h-11"
                disabled={resolveNetworkRequests.isPending}
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              size="sm"
              className="pointer-coarse:min-h-11"
              disabled={requests.length === 0 || !decided || resolveNetworkRequests.isPending}
              onClick={() => void handleSave()}
            >
              {resolveNetworkRequests.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save decisions
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
