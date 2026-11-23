'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  useEnvironmentSetupEnabled,
  useEnvironmentSetupRunMutations,
  type SetupRunResponse,
} from '@/hooks/useEnvironmentSetupRuns';
import { setupTestChatId } from './environment-setup-display';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: SetupRunResponse;
  organizationId?: string;
};

export function NetworkRequestsDialog({ open, onOpenChange, run, organizationId }: Props) {
  const access = useEnvironmentSetupEnabled({ organizationId, enabled: open });
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl [&_button]:pointer-coarse:min-h-11">
        <DialogHeader>
          <DialogTitle>Review recommended hosts</DialogTitle>
          <DialogDescription>
            The agent recommends these hosts from its network audit. Approve only hosts the setup
            needs. It then tests setup with access restricted to allowed hosts.
          </DialogDescription>
        </DialogHeader>
        {open && access.data?.canStart === true && (
          <NetworkDecisions
            run={run}
            organizationId={organizationId}
            onClose={() => onOpenChange(false)}
            onSavingChange={setSaving}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NetworkDecisions({
  run,
  organizationId,
  onClose,
  onSavingChange,
}: {
  run: SetupRunResponse;
  organizationId?: string;
  onClose: () => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const { resolveNetworkRequests } = useEnvironmentSetupRunMutations();
  const [decisions, setDecisions] = useState<Record<string, 'approved' | 'declined'>>({});
  const [error, setError] = useState<string | null>(null);
  const requests = run.networkRequests.filter(request => request.state === 'pending');
  const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
  const save = async () => {
    if (
      !requests.length ||
      requests.some(request => !decisions[request.host]) ||
      resolveNetworkRequests.isPending
    )
      return;
    setError(null);
    onSavingChange(true);
    try {
      await resolveNetworkRequests.mutateAsync({
        organizationId,
        runId: run.id,
        approved: requests
          .filter(request => decisions[request.host] === 'approved')
          .map(request => request.host),
        declined: requests
          .filter(request => decisions[request.host] === 'declined')
          .map(request => request.host),
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save host decisions.');
    } finally {
      onSavingChange(false);
    }
  };
  return (
    <>
      <div className="divide-y">
        {requests.map(request => {
          const evidence = request.evidence;
          const chatId = setupTestChatId(
            run,
            'sessionId' in evidence ? evidence.sessionId : evidence.childSessionId
          );
          return (
            <fieldset
              key={request.host}
              disabled={resolveNetworkRequests.isPending}
              className="min-w-0 space-y-2 py-3 text-sm"
            >
              <legend className="sr-only">Decision for {request.host}</legend>
              <p className="break-all font-mono font-medium">{request.host}</p>
              <p className="break-words whitespace-pre-wrap">
                <span className="text-muted-foreground">Reason given by the agent: </span>
                {request.reason}
              </p>
              <p className="text-muted-foreground text-xs">
                {'requestCount' in evidence
                  ? `Observed ${evidence.requestCount} ${evidence.requestCount === 1 ? 'request' : 'requests'} in the network audit`
                  : `Denied ${evidence.deniedCount} ${evidence.deniedCount === 1 ? 'time' : 'times'} in a test session`}
                {chatId && (
                  <>
                    {' '}
                    ·{' '}
                    <Link
                      className="text-link underline"
                      href={`${basePath}/chat?sessionId=${chatId}`}
                    >
                      Open evidence chat
                    </Link>
                  </>
                )}
              </p>
              <div className="flex flex-wrap gap-4">
                {(['approved', 'declined'] as const).map(decision => (
                  <label
                    key={decision}
                    className="flex cursor-pointer items-center gap-2 py-1 pointer-coarse:min-h-11"
                  >
                    <input
                      type="radio"
                      name={`${run.id}:${request.host}`}
                      value={decision}
                      checked={decisions[request.host] === decision}
                      onChange={() =>
                        setDecisions(previous => ({ ...previous, [request.host]: decision }))
                      }
                      className="accent-primary size-4"
                    />
                    {decision === 'approved' ? 'Approve' : 'Decline'}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button variant="ghost" disabled={resolveNetworkRequests.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={
            resolveNetworkRequests.isPending ||
            !requests.length ||
            requests.some(request => !decisions[request.host])
          }
          onClick={() => void save()}
        >
          {resolveNetworkRequests.isPending ? 'Saving…' : 'Save decisions'}
        </Button>
      </DialogFooter>
    </>
  );
}
