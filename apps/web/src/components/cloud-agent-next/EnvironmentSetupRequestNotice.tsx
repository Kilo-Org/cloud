'use client';

import { useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  isOpenEnvironmentSetupRun,
  useEnvironmentSetupEnabled,
  type SetupRunResponse,
} from '@/hooks/useEnvironmentSetupRuns';
import { EnvironmentDialog } from './EnvironmentDialog';

export function EnvironmentSetupRequestNotice({
  run,
  organizationId,
}: {
  run: SetupRunResponse;
  organizationId?: string;
}) {
  const access = useEnvironmentSetupEnabled({ organizationId });
  const [secretsOpen, setSecretsOpen] = useState(false);
  const secrets = run.secretRequests.filter(request => request.state === 'pending');
  if (!isOpenEnvironmentSetupRun(run.status) || !secrets.length || access.data?.enabled !== true)
    return null;
  if (!access.data.canStart)
    return (
      <Alert variant="warning">
        <CircleHelp aria-hidden />
        <AlertDescription>Waiting for an owner or admin to respond.</AlertDescription>
      </Alert>
    );
  return (
    <div className="space-y-2 [&_button]:pointer-coarse:min-h-11">
      {secrets.length > 0 && (
        <Alert variant="warning">
          <CircleHelp aria-hidden />
          <AlertTitle className="line-clamp-none">
            The setup agent requested {secrets.length} {secrets.length === 1 ? 'secret' : 'secrets'}
          </AlertTitle>
          <AlertDescription>
            <p className="break-all font-mono text-xs">
              {secrets.map(request => request.key).join(', ')}
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={!run.draftEnvironmentId}
              onClick={() => setSecretsOpen(true)}
            >
              Add secrets
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <EnvironmentDialog
        open={secretsOpen}
        onOpenChange={setSecretsOpen}
        organizationId={organizationId}
        repository={undefined}
        environmentId={run.draftEnvironmentId}
        canManage={access.data.canStart}
        initialPage="variables"
        setupRun={run}
        onSaved={() => setSecretsOpen(false)}
        onDeleted={() => setSecretsOpen(false)}
      />
    </div>
  );
}
