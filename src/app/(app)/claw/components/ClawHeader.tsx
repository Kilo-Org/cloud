'use client';

import { Badge } from '@/components/ui/badge';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { SetPageTitle } from '@/components/SetPageTitle';
import { OpenClawButton } from './OpenClawButton';
import { CLAW_STATUS_BADGE, type ClawState } from './claw.types';

export function ClawHeader({
  status,
  sandboxId,
  region,
  gatewayUrl,
  gatewayReady,
  isSetupWizard,
}: {
  status: ClawState;
  sandboxId: string | null;
  region: string | null;
  gatewayUrl: string;
  gatewayReady?: boolean;
  isSetupWizard?: boolean;
}) {
  const statusInfo = status ? CLAW_STATUS_BADGE[status] : null;
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <SetPageTitle
        title="KiloClaw"
        icon={<KiloCrabIcon className="text-muted-foreground h-4 w-4" />}
      >
        <Badge variant="beta">Beta</Badge>
        {statusInfo && (
          <Badge variant="outline" className={statusInfo.className}>
            {statusInfo.label}
          </Badge>
        )}
      </SetPageTitle>
      <div className="flex min-w-0 items-center gap-3">
        {!isSetupWizard && region && (
          <p className="text-muted-foreground min-w-0 truncate font-mono text-sm">
            {region.toUpperCase()} {sandboxId ? `- ${sandboxId}` : ''}
          </p>
        )}
        {!isSetupWizard && (
          <OpenClawButton
            canShow={status === 'running' && !!gatewayReady}
            gatewayUrl={gatewayUrl}
          />
        )}
      </div>
    </header>
  );
}
