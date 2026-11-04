'use client';

import { useState } from 'react';
import { isUserResolvableSetupRunStatus } from '@kilocode/cloud-agent-profile';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';
import { EnvironmentDialog } from './EnvironmentDialog';
import { NetworkRequestsDialog } from './NetworkRequestsDialog';

type EnvironmentSetupRequestNoticeProps = {
  run: SetupRunResponse;
  organizationId?: string;
  organizationName?: string;
  canManage: boolean;
};

function count(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function EnvironmentSetupRequestNotice({
  run,
  organizationId,
  organizationName,
  canManage,
}: EnvironmentSetupRequestNoticeProps) {
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [hostsOpen, setHostsOpen] = useState(false);

  const pendingSecrets = run.secretRequests.filter(request => request.state === 'pending');
  const pendingHosts = run.networkRequests.filter(request => request.state === 'pending');

  if (!isUserResolvableSetupRunStatus(run.status)) {
    return null;
  }

  if (pendingSecrets.length === 0 && pendingHosts.length === 0) {
    return null;
  }

  return (
    <>
      {pendingSecrets.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>
            The setup agent requested {count(pendingSecrets.length, 'secret')}
          </AlertTitle>
          <AlertDescription>
            <p className="font-mono text-xs break-words">
              {pendingSecrets.map(request => request.key).join(', ')}
            </p>
            {canManage ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="pointer-coarse:min-h-11"
                disabled={run.draftEnvironmentId === null}
                onClick={() => setSecretsOpen(true)}
              >
                Add secrets
              </Button>
            ) : (
              <p className="text-sm">Waiting for an owner or admin to respond.</p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {pendingHosts.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>
            The setup agent requested access to {count(pendingHosts.length, 'host')}
          </AlertTitle>
          <AlertDescription>
            {canManage ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="pointer-coarse:min-h-11"
                onClick={() => setHostsOpen(true)}
              >
                Review hosts
              </Button>
            ) : (
              <p className="text-sm">Waiting for an owner or admin to respond.</p>
            )}
          </AlertDescription>
        </Alert>
      )}

      <EnvironmentDialog
        open={secretsOpen}
        onOpenChange={setSecretsOpen}
        organizationId={organizationId}
        organizationName={organizationName}
        repository={undefined}
        environmentId={run.draftEnvironmentId}
        canManage={canManage}
        onSaved={() => setSecretsOpen(false)}
        onDeleted={() => setSecretsOpen(false)}
        initialPage="variables"
        setupRun={run}
      />

      <NetworkRequestsDialog
        open={hostsOpen}
        onOpenChange={setHostsOpen}
        organizationId={organizationId}
        run={run}
      />
    </>
  );
}
